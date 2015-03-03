import fs = require('fs');
import util = require('util');
import path = require('path');
import Promise = require('bluebird');
import _ = require('lodash');

import helpers = require('./helpers');

var objectAssign = require('object-assign');

var RUNTIME = helpers.loadLib('./runtime.d.ts');
var LIB = helpers.loadLib('typescript/bin/lib.d.ts');

export interface AsyncResolver {
    (base: string, dep: string): Promise<string>
}

export interface SyncResolver {
    (base: string, dep: string): string
}

export interface Dependency {
    add(fileName: string): void;
    clear(): void
}

export interface VisitedDeclarations {
    [fileName: string]: boolean
}

export interface File {
    text: string;
    version: number;
}

type FileSet = {[fileName: string]: boolean};

export class Host implements ts.LanguageServiceHost {

    state: State;

    constructor(state: State) {
        this.state = state;
    }

    getScriptFileNames() {
        return Object.keys(this.state.files);
    }

    getScriptVersion(fileName: string) {
        return this.state.files[fileName] && this.state.files[fileName].version.toString();
    }

    getScriptSnapshot(fileName) {
        var file = this.state.files[fileName];

        if (!file) {
            return null;
        }

        return {
            getText: function (start, end) {
                return file.text.substring(start, end);
            },
            getLength: function () {
                return file.text.length;
            },
            getLineStartPositions: function () {
                return [];
            },
            getChangeRange: function (oldSnapshot) {
                return undefined;
            }
        };
    }

    getCurrentDirectory() {
        return process.cwd();
    }

    getScriptIsOpen() {
        return true;
    }

    getCompilationSettings() {
        return this.state.options;
    }

    getDefaultLibFileName(options) {
        return LIB.fileName;
    }

    log(message) {
        //console.log(message);
    }

}

export class DependencyManager {
    dependencies: {[fileName: string]: string[]}
    knownTypeDeclarations: FileSet

    constructor(dependencies: {[fileName: string]: string[]} = {}, knownTypeDeclarations: FileSet = {}) {
        this.dependencies = dependencies;
        this.knownTypeDeclarations = knownTypeDeclarations;
    }

    clone(): DependencyManager {
        return new DependencyManager(
            _.cloneDeep(this.dependencies),
            _.cloneDeep(this.knownTypeDeclarations)
        )
    }

    addDependency(fileName: string, depFileName: string): void {
        if (!this.dependencies.hasOwnProperty(fileName)) {
            this.clearDependencies(fileName);
        }

        this.dependencies[fileName].push(depFileName);
    }

    clearDependencies(fileName: string): void {
        this.dependencies[fileName] = []
    }

    getDependencies(fileName: string): string[] {
        if (!this.dependencies.hasOwnProperty(fileName)) {
            this.clearDependencies(fileName);
        }

        return this.dependencies[fileName].slice()
    }

    addTypeDeclaration(fileName: string) {
        this.knownTypeDeclarations[fileName] = true
    }

    hasTypeDeclaration(fileName: string): boolean {
        return this.knownTypeDeclarations.hasOwnProperty(fileName)
    }

    getTypeDeclarations(): {[fileName: string]: boolean} {
        return objectAssign({}, this.knownTypeDeclarations);
    }

    applyChain(fileName: string, deps: Dependency, appliedChains: FileSet = {}, appliedDeps: FileSet = {}) {
        if (!this.dependencies.hasOwnProperty(fileName)) {
            this.clearDependencies(fileName);
        }

        appliedChains[fileName] = true;

        if (!appliedChains.hasOwnProperty(".d.ts")) {
            appliedChains[".d.ts"] = true;
            Object.keys(this.knownTypeDeclarations).forEach((declFileName) => {
                deps.add(declFileName)
            })
        }

        this.getDependencies(fileName).forEach((depFileName) => {
            if (!appliedDeps.hasOwnProperty(depFileName)) {
                deps.add(depFileName);
                appliedDeps[depFileName] = true;
            }

            if (!appliedChains[depFileName]) {
                this.applyChain(depFileName, deps, appliedChains, appliedDeps);
            }
        })
    }

    recompileReason(fileName: string, changedFiles: string[]): string[] {
        var changedFilesSet: FileSet = {};
        changedFiles.forEach(fileName => changedFilesSet[fileName] = true);
        return this.recompileReasonInternal(fileName, changedFilesSet, {});
    }

    private recompileReasonInternal(fileName: string, changedFilesSet: FileSet, visitedFiles: FileSet): string[] {
        var fileDeps = this.getDependencies(fileName);

        var currentVisitedFiles = objectAssign({}, visitedFiles);
        currentVisitedFiles[fileName] = true;

        for (var i = 0; i < fileDeps.length; i++) {
            var depFileName = fileDeps[i];

            if (changedFilesSet.hasOwnProperty(depFileName)) {
                return [depFileName];
            } else {
                if (currentVisitedFiles.hasOwnProperty(depFileName)) {
                    continue;
                }
                var internal = this.recompileReasonInternal(depFileName, changedFilesSet, currentVisitedFiles);
                if (internal.length) {
                    return [depFileName].concat(internal)
                }
            }
        }

        return [];
    }
}

class ValidManager {
    files: {[fileName: string]: boolean} = {}

    isFileValid(fileName: string): boolean {
        return !!this.files[fileName]
    }

    markFileValid(fileName: string) {
        this.files[fileName] = true;
    }

    markFileInvalid(fileName: string) {
        this.files[fileName] = false;
    }
}

export class State {

    ts: typeof ts;
    fs: typeof fs;
    host: Host;
    files: {[fileName: string]: File} = {};
    services: ts.LanguageService;
    options: ts.CompilerOptions;
    runtimeRead: boolean;

    dependencies = new DependencyManager()
    validFiles = new ValidManager()

    constructor(
        options: ts.CompilerOptions,
        fsImpl: typeof fs,
        tsImpl: typeof ts
    ) {
        this.ts = tsImpl || require('typescript');
        this.fs = fsImpl;
        this.host = new Host(this);
        this.services = this.ts.createLanguageService(this.host, this.ts.createDocumentRegistry());

        this.options = {};
        this.runtimeRead = false;

        objectAssign(this.options, {
            target: this.ts.ScriptTarget.ES5,
            module: this.ts.ModuleKind.CommonJS,
            sourceMap: true,
            verbose: false
        });

        objectAssign(this.options, options);

        this.addFile(RUNTIME.fileName, RUNTIME.text);
        this.addFile(LIB.fileName, LIB.text);
    }

    resetService() {
        this.services = this.ts.createLanguageService(this.host, this.ts.createDocumentRegistry());
    }

    emitAsync(resolver: AsyncResolver, fileName: string, text: string, depsManager: Dependency): Promise<ts.EmitOutput> {
        this.invokeRuntime();
        return this.checkDependencies(resolver, fileName)
            .then((deps) => this.emitAndCheck(fileName))
            .finally(() => this.applyDeps(fileName, depsManager))
    }

    emitSync(resolver: SyncResolver, fileName: string, text: string, depsManager: Dependency): ts.EmitOutput {
        this.invokeRuntime();
        this.checkDependenciesSync(resolver, fileName);
        try {
            return this.emitAndCheck(fileName);
        } finally {
            this.applyDeps(fileName, depsManager)
        }
    }

    invokeRuntime() {
        // Check if we need to compiler Webpack runtime definitions.
        if (!this.runtimeRead) {
            this.services.getEmitOutput(RUNTIME.fileName);
            this.runtimeRead = true;
        }
    }

    applyDeps(fileName: string, depsManager: Dependency) {
        depsManager.clear();
        depsManager.add(fileName);
        this.dependencies.applyChain(fileName, depsManager);
    }

    emitAndCheck(fileName: string): ts.EmitOutput {
        var output = this.services.getEmitOutput(fileName);

        var depsDiagnostics = {};
        var diagnostics = this.services.getCompilerOptionsDiagnostics()

        Object.keys(this.files).forEach((fileName) => {
            diagnostics = diagnostics
                .concat(this.services.getSyntacticDiagnostics(fileName))
                .concat(this.services.getSemanticDiagnostics(fileName));
        });

        if (diagnostics.length) {
            throw new TypeScriptCompilationError(diagnostics, depsDiagnostics);
        }

        if (!output.emitSkipped) {
            return output;
        } else {
            throw new Error("Emit skipped");
        }
    }

    private checkDependencies(resolver: AsyncResolver, fileName: string): Promise<string[]> {
        this.dependencies.clearDependencies(fileName);

        var flow = (!this.files[fileName]) ?
            Promise.resolve(false) :
            this.readFileAndUpdateAsync(fileName);

        return flow.then(() => this.checkDependenciesInternalAsync(resolver, fileName))
    }

    private checkDependenciesInternalAsync(resolver: AsyncResolver, fileName: string): Promise<string[]> {
        var dependencies = this.findImportDeclarations(fileName)
            .map(depRelFileName =>
                this.resolveAsync(resolver, fileName, depRelFileName))
            .map(depFileNamePromise => depFileNamePromise.then(depFileName => {

                var result: Promise<string> = Promise.resolve(depFileName);
                var isTypeDeclaration = /\.d.ts$/.exec(depFileName);
                var isRequiredModule = /\.js$/.exec(depFileName);

                if (isTypeDeclaration) {
                    var hasDeclaration = this.dependencies.hasTypeDeclaration(depFileName);
                    if (!hasDeclaration) {
                        this.dependencies.addTypeDeclaration(depFileName);
                        return this.checkDependencies(resolver, depFileName).then(() => result)
                    }

                } else if (isRequiredModule) {

                    return Promise.resolve(null);

                } else {

                    this.dependencies.addDependency(fileName, depFileName);
                    if (!this.validFiles.isFileValid(depFileName)) {
                        this.validFiles.markFileValid(depFileName);
                        return this.checkDependencies(resolver, depFileName)
                            .catch(ResolutionError, err => {
                                this.validFiles.markFileInvalid(depFileName);
                                throw err
                            })
                            .then(() => result)
                    }

                }

                return result;
            }));

        return Promise.all<string>(dependencies).then(dependencies => {
            return dependencies.filter(val => val != null)
        })
    }

    private checkDependenciesSync(resolver: SyncResolver, fileName: string): string[] {
        this.dependencies.clearDependencies(fileName);

        if (!this.files[fileName]) {
            console.log("NOT FILE")
            this.readFileAndUpdateSync(fileName);
        }

        return this.checkDependenciesInternalSync(resolver, fileName);
    }

    private checkDependenciesInternalSync(resolver: SyncResolver, fileName: string): string[] {
        var dependencies = this.findImportDeclarations(fileName)
            .map(depRelFileName => this.resolveSync(resolver, fileName, depRelFileName))
            .map(depFileName => {
                var isTypeDeclaration = /\.d.ts$/.exec(depFileName);
                var isRequiredModule = /\.js$/.exec(depFileName);

                if (isTypeDeclaration) {
                    var hasDeclaration = this.dependencies.hasTypeDeclaration(depFileName);
                    if (!hasDeclaration) {
                        this.dependencies.addTypeDeclaration(depFileName);
                        this.checkDependenciesSync(resolver, depFileName)
                    }


                } else if (isRequiredModule) {
                    return null
                } else {
                    this.dependencies.addDependency(fileName, depFileName);
                    if (!this.validFiles.isFileValid(depFileName)) {
                        this.validFiles.markFileValid(depFileName);
                        try {
                            this.checkDependenciesSync(resolver, depFileName)
                        } finally {
                            this.validFiles.markFileInvalid(depFileName);
                        }
                    }
                }
            });

        return dependencies.filter(val => val != null);
    }

    private findImportDeclarations(fileName: string) {
        var node = this.services.getSourceFile(fileName);

        var result = [];
        var visit = (node: ts.Node) => {
            if (node.kind === ts.SyntaxKind.ImportEqualsDeclaration) {
                // we need this check to ensure that we have an external import
                if ((<ts.ImportEqualsDeclaration>node).moduleReference.hasOwnProperty("expression")) {
                    result.push((<any>node).moduleReference.expression.text);
                }
            } else if (node.kind === ts.SyntaxKind.SourceFile) {
                result = result.concat((<ts.SourceFile>node).referencedFiles.map(function (f) {
                    return path.resolve(path.dirname((<ts.SourceFile>node).fileName), f.fileName);
                }));
            }

            this.ts.forEachChild(node, visit);
        }
        visit(node);
        return result;
    }

    updateFile(fileName: string, text: string, checked: boolean = false): boolean {
        var prevFile = this.files[fileName];
        var version = 0;
        var changed = true;

        if (prevFile) {
            if (!checked || (checked && text !== prevFile.text)) {
                version = prevFile.version + 1;
            } else {
                changed = false;
            }
        }

        this.files[fileName] = {
            text: text,
            version: version
        };

        return changed
    }

    addFile(fileName: string, text: string): void {
        this.files[fileName] = {
            text: text,
            version: 0
        }
    }

    readFileAsync(fileName: string): Promise<string> {
        var readFile = Promise.promisify(this.fs.readFile.bind(this.fs));
        return readFile(fileName).then(function (buf) {
            return buf.toString('utf8');
        });
    }

    readFileSync(fileName: string): string {
        // Use global fs here, because local doesn't contain `readFileSync`
        return fs.readFileSync(fileName, {encoding: 'utf-8'});
    }

    readFileAndAddAsync(fileName: string): Promise<any> {
        return this.readFileAsync(fileName).then((text) => this.addFile(fileName, text));
    }

    readFileAndUpdateAsync(fileName: string, checked: boolean = false): Promise<boolean> {
        return this.readFileAsync(fileName).then((text) => this.updateFile(fileName, text, checked));
    }

    readFileAndUpdateSync(fileName: string, checked: boolean = false): boolean {
        var text = this.readFileSync(fileName);
        return this.updateFile(fileName, text, checked);
    }

    resolveAsync(resolver: AsyncResolver, fileName: string, defPath: string): Promise<string> {
        var result;

        if (!path.extname(defPath).length) {
            result = resolver(path.dirname(fileName), defPath + ".ts")
                .error(function (error) {
                    return resolver(path.dirname(fileName), defPath + ".d.ts")
                })
                .error(function (error) {
                    return resolver(path.dirname(fileName), defPath)
                })
        } else {
            // We don't need to resolve .d.ts here because they are already
            // absolute at this step.
            if (/\.d\.ts$/.test(defPath)) {
                result = Promise.resolve(defPath)
            } else {
                result = resolver(path.dirname(fileName), defPath)
            }
        }

        return result
            .error(function (error) {
                var detailedError: any = new ResolutionError();
                detailedError.message = error.message + "\n    Required in " + fileName;
                detailedError.cause = error;
                detailedError.fileName = fileName;

                throw detailedError;
            })
    }

    resolveSync(resolver: SyncResolver, fileName: string, defPath: string): string {
        var result;

        try {
            if (!path.extname(defPath).length) {
                try {
                    return resolver(path.dirname(fileName), defPath + ".ts")
                } catch (e) {
                    try {
                        return resolver(path.dirname(fileName), defPath + ".d.ts")
                    } catch (e) {
                        return resolver(path.dirname(fileName), defPath)
                    }
                }
            } else {
                // We don't need to resolve .d.ts here because they are already
                // absolute at this step.
                if (/\.d\.ts$/.test(defPath)) {
                    return defPath
                } else {
                    return resolver(path.dirname(fileName), defPath)
                }
            }
        } catch (error) {
            var detailedError: any = new ResolutionError();
            detailedError.message = error.message + "\n    Required in " + fileName;
            detailedError.cause = error;
            detailedError.fileName = fileName;

            throw detailedError;
        }
    }

}


/**
 * Emit compilation result for a specified fileName.
 */
export class TypeScriptCompilationError {
    constructor(public diagnostics, public depsDiagnostics) {}
}
util.inherits(TypeScriptCompilationError, Error);

/**
 * Emit compilation result for a specified fileName.
 */
export class ResolutionError {
    message: string;
    fileName: string;
    cause: Error;
}
util.inherits(ResolutionError, Error);
