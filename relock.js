#!/usr/bin/env node

var fs = require('fs');
var crypto = require('crypto');
var path = require('path');

var dependencyTrees = {};
var versions = {};
var config = {};

function assignConfig(loaded) {
    Object.assign(config, {
        relockedFilename: 'package.relocked.json',
        packageFilename: 'package.json',
        packageLockedFilename: 'package-lock.json',
        outputRelockedFilename: 'package.relocked.json',
        outputLockedFilename: 'package.relocked.json',
        projectFiles: [],
        verbose: false,
    }, loaded);
}

function loadConfigFile(name) {
    var filename = name || 'relock.cfg.json';
    filename = path.join(process.cwd(), filename);
    var config = JSON.parse(loadFile(filename));
    assignConfig(config);
}

function loadFile(filename) {
    return fs.readFileSync(filename);
}

function saveFile(filename, data) {
    fs.writeFileSync(filename, data);
}

function isProjectModule(moduleName) {
    var re;

    if (moduleName === '') {
        return true;
    }

    for (var idx = 0; idx < config.projectFiles.length; idx++) {
        re = new RegExp(config.projectFiles[idx]);
        if (moduleName.search(re) !== -1) {
            return true;
        }
    }
    return false;
}

function buildPaths(root) {
    var paths = [];

    function one(node, path) {
        node.dependencies = node.dependencies || {};

        Object.keys(node.dependencies).forEach(function(key) {
            var depNode = node.dependencies[key];
            var newPath = path.slice();

            newPath.push(key);
            paths.push(newPath.join('|'));

            one(depNode, newPath);
        });
    }

    paths.push('');
    one(root, []);

    return paths;
}


// the same package version does not necessarily have the same set of dependencies, depending on how it has been locked.
// generate a unique signature that can be used to identify this specific dependency tree for a given locked package and version
function getTreeSignature(tree) {
    var json = JSON.stringify(tree);

    var md5sum = crypto.createHash('md5');
    md5sum.update(json);
    return md5sum.digest('hex');
}

// Given a package-lock file, generate the full package dependency tree.
// Each node in the tree is an object with these properties
// * signature - the md5 hash of dependency tree
// * name
// * version
// * tag - name@version
// * depdencies - sorted array of dependency nodes
// * requires - sorted array of dependencies as requested
function generateDependencyTree(root) {
    var processed = {};
    var lockPaths = buildPaths(root);
    var stack = [];

// given a depdency path, find the path to the correct node in the lock file.
// return the path as a string with a '|' delimiter between module names
    function getLockPath(path, name) {
    // handle the root node
        if (!path.length && !name) {
            return '';
        }

        var searchPath = path.slice();
        var found = '';
        var done = false;

    // follow the path backwards, looking for the first matching module
        do {
            var checkPath = searchPath.slice();
            checkPath.push(name);
            var check = checkPath.join('|');

            if (lockPaths.indexOf(check) != -1) {
                found = check;
            } else if (searchPath.length === 0) {
                done = true;
            } else {
                searchPath.pop();
            }
        } while (!found && !done);

        return found;
    }

// given a path find the node in the lock file
    function getNode(path) {
        var node = root;
        path.forEach(function(part) {
            if (node.dependencies[part]) {
                node = node.dependencies[part];
            } else {
                console.log('cannot find', part);
            }
        });

        return node;
    }

// check from the bottom up, use the first found name match
    function find(name, path) {
    // handle the root
        if (!name && !path.length) {
            return root;
        }

        var lockPath = getLockPath(path, name);
        return getNode(lockPath.split('|') || []);
    }

    function sort(list) {
        return list;
    }

// recursive function that constructs the real dependencies based on the specified requirements
    function one(path) {
        var onePath = path.slice();
        var name = onePath.pop();

    // this handles the root node
        if (!name) {
            name = '';
        }

    // for circular references, just return an empty dependency list
        var lockOnePath = getLockPath(onePath, name);
        if (stack.indexOf(lockOnePath) !== -1) {
            console.log('Circular reference', '"' + lockOnePath + '"', stack);
            return [];
        }
        stack.push(lockOnePath);

    // get the node from the lock file root.
        var lockNode = find(name, onePath);
        var dependencies = [];

    // If we've already done this, return the result
         if (processed[lockOnePath]) {
            stack.pop();
            return processed[lockOnePath];
        }

        lockNode.requires = lockNode.requires || {};
        Object.keys(lockNode.requires).forEach(function(name) {
            var semVer = lockNode.requires[name];
            var depPath;
            var nodeDependencies;
            var signature;
            var realPath = getLockPath(path, name);
            var match = find(name, path);

            if (!match) {
                throw new Error('required module ' + name + ' not found in dependencies');
            }

        // save all the relevent bits in an index for later use. We don't need the dependency list, however
            var nodeVersion = JSON.parse(JSON.stringify(match));
            delete nodeVersion.dependencies;

            versions[name + '@' + match.version] = nodeVersion;

            depPath = realPath.split('|');

            nodeDependencies = one(depPath);
            sort(nodeDependencies);

            var node = {
                name: name,
                version: match.version,
                semVer: semVer,
                tag: name + '@' + match.version,
                requires: match.requires,
            };

            signature = getTreeSignature(nodeDependencies);
            node.signature = signature;
            node.dependencies = nodeDependencies;

            dependencies.push(node);

        // add to global list, to be used when building relocked dependency tree
            dependencyTrees[signature] = nodeDependencies;
        });

        stack.pop();

    // remember this if dependency is ever reencountered
        processed[lockOnePath] = dependencies;
        return dependencies;
    }

    var result = one([]);
    var signature = getTreeSignature(result);
    dependencyTrees[signature] = result;
    var node = {
        requires : root.requires,
        dependencies : result,
        name : '',
        version : root.version,
        signature: signature,
    };

    return node;
}


// generate the relocked dependency tree.
// walk through current tree
// if the actual version is not an allowed version change, then update the rest of the tree with the previous version
// otherwise keep the module
function relockTree(prevTree, curTree) {
    var relockTree;

// add the given node to the relocked dependency tree
// the depdency list of the new node will be empty
    function addNode(node, path) {
        searchPath = path.slice();

    // handle the root
        if (!path.length) {
            relockTree = node;
            return;
        }

    // get the parent node
        var addPath = path.slice();
        addPath.pop();
        var relockParent = getNode(relockTree, addPath)

    // add this node to its dependencies
        relockParent.dependencies.push(node);
    }

// the dependendency by name
    function find(dependencies, name) {
        if (!dependencies) {
            return;
        }

        return dependencies.find(function(dependency) {
            return dependency.name === name;
        });
    }

// get the node from the depdency tree at the given path
    function getNode(tree, path) {
        searchPath = path.slice();
        var node = tree;
        while (searchPath.length) {
            part = searchPath.shift();
            node = find(node.dependencies, part);
            if (!node) {
                console.log('cannot find' + path.join('|'));
                return;
            }
        }

        return node;
    }

    function cleanSemVer(semVer) {
        semVer = semVer.replace('~', '');
        semVer = semVer.replace('^', '');

        return semVer;
    }

    function notPatch(curSemVer, prevSemVer) {
        var curVer = cleanSemVer(curSemVer).split('.');
        var prevVer =cleanSemVer(prevSemVer).split('.');

        return curVer[0] != prevVer[0] || curVer[1] != prevVer[1]
    }

// recursive function to process one node at the given path
    function one(path) {
        var curNode = getNode(curTree, path);
        var prevNode = getNode(prevTree, path);
        var relockNode = JSON.parse(JSON.stringify(curNode));
        var dependencyNode;

        relockNode.dependencies = [];
        addNode(relockNode, path);

    // use the requires as an index into the dependencies
        var curKeys = Object.keys(curNode.requires)
        for (var idx = 0; idx < curKeys.length; idx++) {
            var key = curKeys[idx];
            var curVer = curNode.requires[key];
            var prevVer = prevNode.requires[key];

        // if it didnt exist add whole tree
        // if it was more than a patch update, add the whole tree
        // if it is due to a semver change or this is a project file, add it and check children
        // otherwise, revert to previous tree
            if (!prevVer) {
                dependencyNode = find(curNode.dependencies, key);
                relockNode.dependencies.push(dependencyNode);
            } else if (notPatch(curVer, prevVer)) {
                dependencyNode = find(curNode.dependencies, key);
                relockNode.dependencies.push(dependencyNode);
            } else if (prevVer != curVer || isProjectModule(key)) {
                let newPath = path.slice();
                newPath.push(key);
                one(newPath);
            } else {
                dependencyNode = find(prevNode.dependencies, key);
                relockNode.dependencies.push(dependencyNode);
            }
        }
    }

    one([]);

    return relockTree;
}

// hoist dependencies
function flattenTree(tree) {
    var modules = [];
    var moduleIndex = {};
    var flatTree = {};

    function buildIndexes(node, path) {
        node.dependencies.forEach(function(dependency) {
            var newPath = path.slice();
            var name = dependency.name + '|' + dependency.version + '|' + dependency.signature;
            var module;

            newPath.push(dependency.name);
            if (!moduleIndex[name]) {
                module = {
                    name: dependency.name,
                    version: dependency.version,
                    signature: dependency.signature,
                    variant: name,
                    depth: path.length,
                    paths: [],
                }
                moduleIndex[name] = module;
                modules.push(module);
            } else {
                module = moduleIndex[name];
            }

            module.depth = Math.min(module.depth, path.length);
            module.paths.push(newPath.join('|'));
            buildIndexes(dependency, newPath);
        });
    }

    function add(path, variant) {
        function insert(node, name, version, variant) {
//            console.log('adding', searchPath.join('|'), variant, name);
            node.dependencies[name] = {
                name: name,
                version: version,
                variant: variant,
                dependencies: {},
            };
        }

        var searchPath = path.split('|').slice();
        var node = flatTree;
        var spec = variant.split('|');
        var name = spec[0];
        var version = spec[1];
        done = false;

        do {
            try {
                var found = node.dependencies[name];
            } catch (e) {
                console.log('error-----------------------');
                console.log(path);
                console.log(variant);
                console.log(name);
                console.log(JSON.stringify(flatTree, null, '  '));

                throw (e);
            }

        // already there, skip it
            if (found && found.variant === variant) {
//                console.log('already there', searchPath.join('|'), variant, name);
                return false;
            }

        // found conflict, continue down path
            if (found) {
                var part = searchPath.shift();
            // no where to go, add it
                if (!node.dependencies[part]) {
                    insert(node, name, version, variant);
                    return true;
                }
                node = node.dependencies[part];
            } else {
//                console.log('adding', searchPath.join('|'), variant, name);
                insert(node, name, version, variant);
                return true;
            }
        } while (!done)
    }

    function hoistOne(module) {
        module.paths.forEach(function(path) {
            add(path, module.variant)
        }, this);
    }

    function sortModules() {
        function compare(a, b) {

        // first sort by depth
            var result = a.depth - b.depth;

            if (result !== 0) {
                return result;
            }
/*
            console.log('---------------------------------depth matches', result, a.path, b.path);
            console.log(result);
            console.log(a.path);
            console.log(b.path);
*/

        // then sort by freuency of module use
            var frequency = b.paths.length - a.paths.length;
            if (frequency !== 0) {
                return frequency;
            }

        // then sort alphabetically to get a predictable result
            var aPath = a.paths[0].split('|');
            aPath.push(a.name);
            aPath = aPath.join('|');

            var bPath = b.paths[0].split('|');
            bPath.push(b.name);
            bPath = bPath.join('|');

            if (aPath < bPath) {
                return -1;
            }

            if (aPath > bPath) {
                return 1;
            }

            return 0;
        }

        modules.sort(compare);
    }

    function hoist() {
        sortModules();
        Object.assign(flatTree, tree);

        flatTree.dependencies = {};
        node = flatTree;

        modules.forEach(function(module) {
            hoistOne(module);
        });
    }

    buildIndexes(tree, []);
    hoist();
//    console.log(JSON.stringify(modules, null, '  '));

    console.log('HOISTED');
    return flatTree;
}

// given the relocked tree, make the new lock file
function buildLockFile(tree, curRoot) {
    var lockFile = {
        name: curRoot.name,
        version: curRoot.version,
        lockfileVersion: 1,
        requires: true,
    }

    function one(flatNode) {
        var dependencies = {};
        var keys = Object.keys(flatNode.dependencies);
        keys.sort();
        keys.forEach(function(key) {
            var dependency = flatNode.dependencies[key];
            var name = dependency.name;
            var version = dependency.version;
            var content = versions[name + '@' + version];
            var newNode = JSON.parse(JSON.stringify(content));

            dependencies[dependency.name] = newNode;
            newNode.dependencies = one(dependency);
        });

        return dependencies;
    }

    lockFile.dependencies = one(tree);
    return lockFile;
}

// walk the currentLockedFile, compare changed dependencies to previous dependencies, output the relocked
// file based on specific module version changes.
function relock(previous, current) {
    var prevTree = generateDependencyTree(previous);
    var curTree = generateDependencyTree(current);
    var relockedTree = relockTree(prevTree, curTree);
    var finalTree = flattenTree(relockedTree);

    curTree.name = current.name;
    curTree.version = current.version;

    return buildLockFile(finalTree, curTree);
}

// there is no previous relock file, so create it from the current package.json and package-lock.json
function handleFirstTime() {
    var packageFilename = path.join(process.cwd(), config.packageFilename);
    var packageLockFilename = path.join(process.cwd(), config.packageLockedFilename);
    var outputRelockedFilename = path.join(process.cwd(), config.outputRelockedFilename);
    var curPackageJSON = loadFile(packageFilename);
    var curPackage = JSON.parse(curPackageJSON);
    var curLockJSON = loadFile(packageLockFilename);
    var curLock = JSON.parse(curLockJSON);
    curLock.requires = Object.assign({}, curPackage.dependencies, curPackage.devDependencies);

    saveFile(outputRelockedFilename, JSON.stringify(curLock, null, '  '));
}

function main() {
    loadConfigFile();

    try {
        var relockFilename = path.join(process.cwd(), config.relockedFilename);
        var prevLockJSON = loadFile(relockFilename);
    } catch (e) {
    // must be the first time
        handleFirstTime();
        return;
    }

    var packageFilename = path.join(process.cwd(), config.packageFilename);
    var packageLockFilename = path.join(process.cwd(), config.packageLockedFilename);

    var outputRelockedFilename = path.join(process.cwd(), config.outputRelockedFilename);
    var outputLockedFilename = path.join(process.cwd(), config.outputLockedFilename);

    var prevLockJSON = loadFile(relockFilename);
    var curPackageJSON = loadFile(packageFilename);
    var curLockJSON = loadFile(packageLockFilename);

    var prevLock = JSON.parse(prevLockJSON);

    var curPackage = JSON.parse(curPackageJSON);
    var curLock = JSON.parse(curLockJSON);

    curLock.requires = Object.assign({}, curPackage.dependencies, curPackage.devDependencies);

    var final = relock(prevLock, curLock)

    saveFile(outputLockedFilename, JSON.stringify(final, null, '  '));
    final.requires = curPackage.dependencies;
    saveFile(outputRelockedFilename, JSON.stringify(final, null, '  '));

    console.log(JSON.stringify(final, null, '  '));
}

main();
