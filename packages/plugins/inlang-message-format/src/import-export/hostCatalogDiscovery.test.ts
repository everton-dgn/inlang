import { expect, test, vi } from "vitest";
import {
	loadProjectFromDirectory,
	saveProjectToDirectory,
	selectBundleNested,
	type InlangPlugin,
	type InlangProject,
} from "@inlang/sdk";
import { Value } from "@sinclair/typebox/value";
import { Volume } from "memfs";
import { plugin } from "../plugin.js";
import { PLUGIN_KEY } from "../pluginKey.js";
import { PluginSettings } from "../settings.js";

// loading and saving projects with the SDK is slow on CI
vi.setConfig({ testTimeout: 30_000 });

/**
 * Colocated catalogs (one `i18n/` folder per feature) with the current API:
 * the plugin lists literal paths from `settings` and the host reads them.
 */

const locales = ["en", "de"];

const settings = (pathPattern: string | string[]) =>
	JSON.stringify({
		baseLocale: "en",
		locales,
		modules: [],
		[PLUGIN_KEY]: { pathPattern },
	});

const load = (volume: InstanceType<typeof Volume>) =>
	loadProjectFromDirectory({
		path: "/repo/project.inlang",
		fs: volume as any,
		providePlugins: [plugin as InlangPlugin],
	});

/** The text of every message by bundle id and locale. */
async function texts(project: InlangProject) {
	const bundles = await selectBundleNested(project.db).execute();
	const result: Record<string, Record<string, string>> = {};
	for (const bundle of bundles) {
		for (const message of bundle.messages) {
			const part = message.variants[0]?.pattern[0];
			(result[bundle.id] ??= {})[message.locale] =
				part?.type === "text" ? part.value : "";
		}
	}
	return result;
}

const json = (value: Record<string, string>) => JSON.stringify(value);

test("a manual pathPattern array imports every listed folder; a duplicate key silently takes the last file", async () => {
	const volume = Volume.fromJSON({
		"/repo/project.inlang/settings.json": settings([
			"./src/a/i18n/{locale}.json",
			"./src/b/i18n/{locale}.json",
		]),
		"/repo/src/a/i18n/en.json": json({ a_title: "A", shared_key: "from A" }),
		"/repo/src/a/i18n/de.json": json({ a_title: "A de", shared_key: "von A" }),
		"/repo/src/b/i18n/en.json": json({ b_title: "B", shared_key: "from B" }),
		"/repo/src/b/i18n/de.json": json({ b_title: "B de", shared_key: "von B" }),
	});
	const project = await load(volume);

	expect(await project.errors.get()).toEqual([]);
	expect(await texts(project)).toEqual({
		a_title: { en: "A", de: "A de" },
		b_title: { en: "B", de: "B de" },
		shared_key: { en: "from B", de: "von B" },
	});
});

// Loads again instead of watching: no watcher is involved.
test("a folder created after a load is only imported once settings.json lists it and the project is loaded again", async () => {
	const volume = Volume.fromJSON({
		"/repo/project.inlang/settings.json": settings([
			"./src/a/i18n/{locale}.json",
		]),
		"/repo/src/a/i18n/en.json": json({ a_title: "A" }),
		"/repo/src/a/i18n/de.json": json({ a_title: "A de" }),
	});
	const first = await load(volume);
	expect(Object.keys(await texts(first))).toEqual(["a_title"]);

	volume.mkdirSync("/repo/src/c/i18n", { recursive: true });
	volume.writeFileSync("/repo/src/c/i18n/en.json", json({ c_title: "C" }));
	volume.writeFileSync("/repo/src/c/i18n/de.json", json({ c_title: "C de" }));
	expect(Object.keys(await texts(first))).toEqual(["a_title"]);

	const reloaded = await load(volume);
	expect(await reloaded.errors.get()).toEqual([]);
	expect(Object.keys(await texts(reloaded))).toEqual(["a_title"]);

	volume.writeFileSync(
		"/repo/project.inlang/settings.json",
		settings(["./src/a/i18n/{locale}.json", "./src/c/i18n/{locale}.json"])
	);
	const after = await load(volume);
	expect(Object.keys(await texts(after)).sort()).toEqual([
		"a_title",
		"c_title",
	]);
});

test("a glob in pathPattern passes the settings schema but reads no file and reports nothing", async () => {
	expect(
		Value.Check(PluginSettings, { pathPattern: "./src/**/i18n/{locale}.json" })
	).toBe(true);
	const volume = Volume.fromJSON({
		"/repo/project.inlang/settings.json": settings(
			"./src/**/i18n/{locale}.json"
		),
		"/repo/src/a/i18n/en.json": json({ a_title: "A" }),
		"/repo/src/a/i18n/de.json": json({ a_title: "A de" }),
	});
	const project = await load(volume);

	expect(await project.errors.get()).toEqual([]);
	expect(await texts(project)).toEqual({});
});

test("a folder without a locale file loads without an error", async () => {
	const volume = Volume.fromJSON({
		"/repo/project.inlang/settings.json": settings([
			"./src/a/i18n/{locale}.json",
			"./src/b/i18n/{locale}.json",
		]),
		"/repo/src/a/i18n/en.json": json({ a_title: "A" }),
		"/repo/src/a/i18n/de.json": json({ a_title: "A de" }),
		"/repo/src/b/i18n/en.json": json({ b_title: "B" }),
	});
	const project = await load(volume);

	expect(await project.errors.get()).toEqual([]);
	expect(await texts(project)).toEqual({
		a_title: { en: "A", de: "A de" },
		b_title: { en: "B" },
	});
});

// The host writes an exported file without `metadata.pathPattern` to every
// path of the array, also without edits (see saveProjectToDirectory.test.ts).
test("saving a project with a pathPattern array writes every message of a locale to every listed file", async () => {
	const volume = Volume.fromJSON({
		"/repo/project.inlang/settings.json": settings([
			"./src/a/i18n/{locale}.json",
			"./src/b/i18n/{locale}.json",
		]),
		"/repo/src/a/i18n/en.json": json({ a_title: "A" }),
		"/repo/src/a/i18n/de.json": json({ a_title: "A de" }),
		"/repo/src/b/i18n/en.json": json({ b_title: "B" }),
		"/repo/src/b/i18n/de.json": json({ b_title: "B de" }),
	});
	const project = await load(volume);
	await saveProjectToDirectory({
		path: "/repo/project.inlang",
		fs: volume.promises as any,
		project,
	});

	const read = (path: string) =>
		JSON.parse(volume.readFileSync(path, "utf-8") as string);
	for (const folder of ["a", "b"]) {
		expect(read(`/repo/src/${folder}/i18n/en.json`)).toMatchObject({
			a_title: "A",
			b_title: "B",
		});
	}
});
