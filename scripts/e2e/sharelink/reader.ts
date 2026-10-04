const app = process.argv[2];
if (!app || !/^[a-z0-9_-]+$/.test(app)) throw new Error("Missing test app");
console.log(await Bun.file(`/snapshots/${app}/offers.json`).text());
