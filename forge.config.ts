import { FuseV1Options, FuseVersion } from "@electron/fuses";
import type {
  HookFunction,
} from "@electron/packager";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerWix } from "@electron-forge/maker-wix";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import MakerAppImage from "@pengx17/electron-forge-maker-appimage";
import { execSync } from "child_process";
import crypto from "crypto";
import setLanguages from "electron-packager-languages";
import * as fs from "fs";
import * as path from "path";
import { stringify as yamlStringify } from "yaml";

// Fix for AppImage build issues on some Linux distributions (like Arch/CachyOS)
// This environment variable forces appimagetool to extract files instead of mounting them via FUSE.
process.env.APPIMAGE_EXTRACT_AND_RUN = '1';

const keepLanguages = ["en", "en-US", "zh-CN", "ru"];
const windowsExecutableName = "antigravity-manager";

const isStartCommand = process.argv.some((arg) => arg.includes("start"));

const artifactRegex = /.*\.(?:exe|dmg|AppImage|zip|deb|rpm|msi)$/;
const platformNamesMap: Record<string, string> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};
const ymlBaseNameMap: Record<string, string> = {
  darwin: "latest-mac",
  linux: "latest-linux",
  win32: "latest",
};
const ignorePatterns = [
  /^\/\.git/,
  /^\/\.github/,
  /^\/\.vscode/,
  /^\/\.agents?/,
  /^\/\.agent/,
  /^\/openspec/,
  /^\/docs?/,
  /^\/scripts?/,
  /^\/tests?/,
  /^\/mocks?/,
  /^\/src/,
  /^\/node_modules\/\.cache/,
  /^\/pnpm-lock\.yaml/,
  /^\/pnpm-workspace\.yaml/,
  /^\/\.npmrc/,
  /^\/test\.db/,
  /^\/build\.log/,
  /^\/electron-packager/,
];

function normalizeArtifactName(value?: string) {
  if (!value) {
    return "app";
  }

  return value
    .trim()
    .replace(/\s+/g, ".")
    .replace(/[^a-zA-Z0-9.]/g, "")
    .replace(/\.+/g, ".");
}

function isSquirrelArtifact(artifactPath: string) {
  const fileName = path.basename(artifactPath);
  if (fileName === "RELEASES") {
    return true;
  }

  return artifactPath.endsWith(".nupkg");
}

function mapArchName(arch: string, mapping: Record<string, string>) {
  return mapping[arch] || arch;
}

function getArtifactFileName({
  baseName,
  version,
  arch,
  extension,
}: {
  baseName: string;
  version: string;
  arch: string;
  extension: string;
}) {
  if (extension === ".rpm") {
    return `${baseName}-${version}-1.${arch}${extension}`;
  }

  if (extension === ".deb") {
    return `${baseName}_${version}_${arch}${extension}`;
  }

  if (extension === ".AppImage") {
    return `${baseName}_${version}_${arch}${extension}`;
  }

  if (extension === ".dmg") {
    return `${baseName}_${version}_${arch}${extension}`;
  }

  if (extension === ".exe") {
    return `${baseName}_${version}_${arch}-setup${extension}`;
  }

  if (extension === ".msi") {
    return `${baseName}_${version}_${arch}_en-US${extension}`;
  }

  if (extension === ".zip") {
    return `${baseName}_${version}_${arch}${extension}`;
  }

  return `${baseName}_${version}_${arch}${extension}`;
}

function getUpdateYmlFileName(platform: string, arch: string) {
  const baseName = ymlBaseNameMap[platform];
  if (!baseName) {
    return null;
  }

  if (platform === "darwin") {
    return arch === "universal" ? `${baseName}.yml` : `${baseName}-${arch}.yml`;
  }

  if (platform === "linux") {
    return arch === "x64" ? `${baseName}.yml` : `${baseName}-${arch}.yml`;
  }

  if (platform === "win32") {
    return arch === "x64" ? `${baseName}.yml` : `${baseName}-${arch}.yml`;
  }

  return null;
}

function getChecksumArchLabel(platform: string, arch: string) {
  if (platform === "linux") {
    return mapArchName(arch, { x64: "amd64", arm64: "aarch64" });
  }

  if (platform === "darwin") {
    return mapArchName(arch, {
      x64: "x64",
      arm64: "arm64",
      universal: "universal",
    });
  }

  if (platform === "win32") {
    return mapArchName(arch, { x64: "x64", arm64: "arm64" });
  }

  return arch;
}

const appImageMaker = new MakerAppImage({
  config: {
    icons: [
      {
        file: "images/32x32.png",
        size: 32,
      },
      {
        file: "images/64x64.png",
        size: 64,
      },
      {
        file: "images/128x128.png",
        size: 128,
      },
      {
        file: "images/128x128@2x.png",
        size: 256,
      },
    ],
  },
});
appImageMaker.name = "@pengx17/electron-forge-maker-appimage";

function hasBinary(binary: string): boolean {
  try {
    const command =
      process.platform === "win32" ? `where ${binary}` : `which ${binary}`;
    execSync(command, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const packagerAfterCopy: HookFunction[] = [
  // 1. Surgical Native Module Copy for Size Optimization
  (buildPath, _electronVersion, _platform, _arch, callback) => {
    const nodeModulesPath = path.join(buildPath, 'node_modules');
    const nativeModules = ['better-sqlite3', 'keytar', 'bindings', 'file-uri-to-path'];

    const copyMinimalModule = (moduleName: string) => {
      const srcPath = path.join(process.cwd(), 'node_modules', moduleName);
      const destPath = path.join(nodeModulesPath, moduleName);

      if (!fs.existsSync(srcPath)) return;

      fs.mkdirSync(destPath, { recursive: true });
      
      const bloat = [
        'src', 'deps', 'test', 'tests', 'docs', 'doc', 'samples', 
        'examples', 'benchmark', 'benchmarks', 'scripts',
        '.github', 'appveyor.yml', '.travis.yml', '.npmignore',
        'tsconfig.json', 'binding.gyp'
      ];

      const copyWithFilter = (s: string, d: string) => {
        const files = fs.readdirSync(s);
        for (const file of files) {
          if (bloat.includes(file)) continue;
          const curSrc = path.join(s, file);
          const curDest = path.join(d, file);
          const stat = fs.statSync(curSrc);
          if (stat.isDirectory()) {
            fs.mkdirSync(curDest, { recursive: true });
            copyWithFilter(curSrc, curDest);
          } else {
            fs.copyFileSync(curSrc, curDest);
            if (process.platform === 'linux' && curDest.endsWith('.node')) {
              try { execSync(`strip --strip-unneeded "${curDest}"`); } catch {}
            }
          }
        }
      };
      
      copyWithFilter(srcPath, destPath);
    };

    for (const moduleName of nativeModules) {
      copyMinimalModule(moduleName);
    }

    const assetsSrc = path.join(process.cwd(), 'src', 'assets');
    const assetsDest = path.join(buildPath, 'resources', 'assets');
    if (fs.existsSync(assetsSrc)) {
      fs.cpSync(assetsSrc, assetsDest, { recursive: true });
    }

    callback();
  },
  // 2. Language Pruning
  setLanguages(keepLanguages),
];

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/*.node',
    },
    name: "Antigravity Manager",
    executableName: windowsExecutableName,
    icon: "images/icon",
    extraResource: ["src/assets"],
    afterCopy: packagerAfterCopy,
    ignore: ignorePatterns,
    prune: true,
  },
  rebuildConfig: {},
  hooks: {
    postMake: async (_config, makeResults) => {
      if (!makeResults?.length) {
        return makeResults;
      }

      const ymlByTarget = new Map<
        string,
        {
          basePath: string;
          fileName: string;
          yml: {
            version?: string;
            files: {
              url: string;
              sha512: string;
              size: number;
            }[];
            releaseDate?: string;
          };
        }
      >();
      const checksumByTarget = new Map<
        string,
        {
          basePath: string;
          fileName: string;
          lines: string[];
        }
      >();

      makeResults = makeResults.map((result) => {
        const productName = normalizeArtifactName(
          result.packageJSON?.productName || result.packageJSON?.name || 'AntigravityManager',
        );
        const platformName = platformNamesMap[result.platform] || result.platform;
        const version = result.packageJSON.version;
        const platformKey = result.platform;
        const archKey = result.arch;
        const updateFileName = getUpdateYmlFileName(platformKey, archKey);
        const updateKey = updateFileName ? `${platformKey}-${archKey}` : null;
        const checksumKey = `${platformKey}-${archKey}`;
        const checksumArchLabel = getChecksumArchLabel(platformKey, archKey);
        const checksumFileName = `sha256sums-${platformName}-${checksumArchLabel}.txt`;

        if (!checksumByTarget.has(checksumKey)) {
          checksumByTarget.set(checksumKey, {
            basePath: "",
            fileName: checksumFileName,
            lines: [],
          });
        }

        if (updateFileName && updateKey && !ymlByTarget.has(updateKey)) {
          ymlByTarget.set(updateKey, {
            basePath: "",
            fileName: updateFileName,
            yml: {
              version,
              files: [],
            },
          });
        }

        const updateState = updateKey ? ymlByTarget.get(updateKey)! : null;
        const checksumState = checksumByTarget.get(checksumKey)!;

        result.artifacts = result.artifacts
          .map((artifact) => {
            if (!artifact || isSquirrelArtifact(artifact) || !artifactRegex.test(artifact)) {
              return artifact;
            }

            if (!checksumState.basePath) {
              checksumState.basePath = path.dirname(artifact);
            }

            if (updateState && !updateState.basePath) {
              updateState.basePath = path.dirname(artifact);
            }

            const extension = path.extname(artifact);
            let archLabel = archKey;
            if (platformKey === "linux" && (extension === ".rpm" || extension === ".AppImage")) {
              archLabel = mapArchName(archKey, { x64: "amd64", arm64: "aarch64" });
            } else if (platformKey === "linux" && extension === ".deb") {
              archLabel = mapArchName(archKey, { x64: "amd64", arm64: "arm64" });
            } else if (platformKey === "darwin") {
              archLabel = mapArchName(archKey, { x64: "x64", arm64: "arm64", universal: "universal" });
            } else if (platformKey === "win32") {
              archLabel = mapArchName(archKey, { x64: "x64", arm64: "arm64" });
            }

            const newArtifact = path.join(path.dirname(artifact), getArtifactFileName({
              baseName: productName,
              version,
              arch: archLabel,
              extension,
            }));

            if (newArtifact !== artifact) {
              fs.renameSync(artifact, newArtifact);
            }

            try {
              const fileData = fs.readFileSync(newArtifact);
              const hash = crypto.createHash("sha512").update(fileData).digest("base64");
              const sha256 = crypto.createHash("sha256").update(fileData).digest("hex");
              const { size } = fs.statSync(newArtifact);

              if (updateState) {
                updateState.yml.files.push({
                  url: path.basename(newArtifact),
                  sha512: hash,
                  size,
                });
              }

              checksumState.lines.push(`${sha256}  ${path.basename(newArtifact)}`);
            } catch {
              console.error(`Failed to hash ${newArtifact}`);
            }

            return newArtifact;
          })
          .filter((artifact): artifact is string => artifact !== null);

        return result;
      });

      const releaseDate = new Date().toISOString();
      for (const [updateKey, updateState] of ymlByTarget.entries()) {
        if (!updateState.basePath) continue;

        updateState.yml.releaseDate = releaseDate;
        const ymlPath = path.join(updateState.basePath, updateState.fileName);
        fs.writeFileSync(ymlPath, yamlStringify(updateState.yml));

        const [platform, arch] = updateKey.split("-");
        const sampleResult = makeResults.find((result) => result.platform === platform && result.arch === arch);
        if (sampleResult) {
          makeResults.push({
            artifacts: [ymlPath],
            platform: sampleResult.platform,
            arch: sampleResult.arch,
            packageJSON: sampleResult.packageJSON,
          });
        }
      }

      for (const [checksumKey, checksumState] of checksumByTarget.entries()) {
        if (!checksumState.basePath || checksumState.lines.length === 0) continue;

        const checksumPath = path.join(checksumState.basePath, checksumState.fileName);
        fs.writeFileSync(checksumPath, `${checksumState.lines.join("\n")}\n`);

        const [platform, arch] = checksumKey.split("-");
        const sampleResult = makeResults.find((result) => result.platform === platform && result.arch === arch);
        if (sampleResult) {
          makeResults.push({
            artifacts: [checksumPath],
            platform: sampleResult.platform,
            arch: sampleResult.arch,
            packageJSON: sampleResult.packageJSON,
          });
        }
      }

      return makeResults;
    },
  },
  makers: [
    new MakerSquirrel({
      setupIcon: "images/icon.ico",
      iconUrl: "https://raw.githubusercontent.com/Draculabo/AntigravityManager/main/images/icon.ico",
    }),
    ...(process.platform === "win32" && process.arch === "x64"
      ? [
          new MakerWix({
            language: 1033,
            icon: path.join(process.cwd(), "images", "icon.ico"),
            exe: `${windowsExecutableName}.exe`,
            ui: { chooseDirectory: true },
          }),
        ]
      : []),
    new MakerDMG({ overwrite: true, icon: "images/icon.icns", iconSize: 160 }, ["darwin"]),
    new MakerZIP({}, ["darwin"]),
    appImageMaker,
    ...(process.platform === "linux" && hasBinary("rpmbuild") ? [new MakerRpm({})] : []),
    ...(process.platform === "linux" && hasBinary("dpkg") ? [new MakerDeb({})] : []),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: { owner: "Draculabo", name: "AntigravityManager" },
        draft: true,
        prerelease: false,
      },
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.mts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.mts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.mts" }],
    }),
    ...(!isStartCommand
      ? [
          new AutoUnpackNativesPlugin({}),
          new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
          }),
        ]
      : []),
  ],
};

export default config;
