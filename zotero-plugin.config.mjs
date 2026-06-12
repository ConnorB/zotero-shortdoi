import { readFileSync } from "node:fs";
import { defineConfig } from "zotero-plugin-scaffold";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

const addonID = "zoteroshortdoi@wiernik.org";
const addonNamespace = "zoteroshortdoi";

export default defineConfig({
  source: "addon",
  dist: ".scaffold/build",
  name: "DOI Manager",
  id: addonID,
  namespace: addonNamespace,
  xpiName: `zotero-doi-manager-${pkg.version}`,
  updateURL:
    "https://github.com/ConnorB/zotero-shortdoi/releases/download/release/{{updateJson}}",
  xpiDownloadLink:
    "https://github.com/ConnorB/zotero-shortdoi/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*", "!addon/lib/__tests__/**"],
    fluent: {
      prefixLocaleFiles: false,
      prefixFluentMessages: false,
      dts: false,
    },
    prefs: {
      prefixPrefKeys: false,
      dts: false,
    },
    makeManifest: {
      enable: true,
    },
    makeUpdateJson: {
      hash: true,
    },
    hooks: {
      "build:done": (ctx) => {
        ctx.logger.info(`Built ${ctx.dist}/${ctx.xpiName}.xpi`);
      },
    },
  },

  release: {
    bumpp: {
      execute: "npm run build",
      all: true,
      commit: "chore(release): publish v%s",
      tag: "v%s",
    },
    github: {
      repository: "ConnorB/zotero-shortdoi",
      updater: "release",
    },
  },
});
