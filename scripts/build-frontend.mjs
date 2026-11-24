// Bound native bundler parallelism on Windows, including builds in synced folders.
if (process.platform === 'win32') process.env.RAYON_NUM_THREADS ??= '2';
const { build } = await import('vite');
await build();
