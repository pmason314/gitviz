const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
    minify: false,
    logLevel: 'info',
};

if (watch) {
    esbuild.context(buildOptions).then((ctx) => {
        ctx.watch();
        console.log('Watching for changes...');
    });
} else {
    esbuild.build(buildOptions).catch(() => process.exit(1));
}
