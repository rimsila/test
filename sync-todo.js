#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const SCRIPT_DIR = __dirname;
const DEFAULT_SOURCE = SCRIPT_DIR;
const DEFAULT_REMOTE_PATH = "todo";
const DEFAULT_CREDENTIALS = path.join(SCRIPT_DIR, "google-drive-credentials.json");
const DEFAULT_TOKEN = path.join(SCRIPT_DIR, ".google-drive-token.json");
const DEFAULT_EXCLUDES = path.join(SCRIPT_DIR, "rclone-exclude.txt");
const DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive"];
let googleClient;

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  try {
    ({ google: googleClient } = require("googleapis"));
  } catch {
    throw new Error("Missing dependency 'googleapis'. Run 'npm install' first.");
  }

  const source = path.resolve(options.source);
  const excludeRules = await loadExcludeRules(options.excludeFile);

  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Source folder does not exist: ${source}`);
  }

  if (!fs.existsSync(options.credentialsFile)) {
    throw new Error(
      `Credentials file not found: ${options.credentialsFile}\n` +
        "Create a Google OAuth desktop app credential and save it there."
    );
  }

  const auth = await authorize(options.credentialsFile, options.tokenFile);
  const drive = googleClient.drive({ version: "v3", auth });

  const remoteRootId = await ensureRemotePath(drive, options.remotePath, options.dryRun);
  const tree = await collectLocalTree(source, excludeRules);

  const folderIds = new Map([["", remoteRootId]]);
  for (const relativeDir of tree.directories) {
    const parentRelativeDir = path.posix.dirname(relativeDir) === "." ? "" : path.posix.dirname(relativeDir);
    const parentId = folderIds.get(parentRelativeDir);
    const dirName = path.posix.basename(relativeDir);
    const folderId = await ensureChildFolder(drive, parentId, dirName, options.dryRun);
    folderIds.set(relativeDir, folderId);
  }

  for (const relativeFile of tree.files) {
    const parentRelativeDir = path.posix.dirname(relativeFile) === "." ? "" : path.posix.dirname(relativeFile);
    const parentId = folderIds.get(parentRelativeDir);
    const fileName = path.posix.basename(relativeFile);
    const localPath = path.join(source, relativeFile);
    await uploadOrUpdateFile(drive, parentId, fileName, localPath, options.dryRun);
  }

  console.log(
    options.dryRun
      ? `Dry run complete. ${tree.files.length} files would be uploaded or updated.`
      : `Sync complete. Uploaded or updated ${tree.files.length} files.`
  );
}

function parseArgs(args) {
  const options = {
    source: DEFAULT_SOURCE,
    remotePath: DEFAULT_REMOTE_PATH,
    credentialsFile: DEFAULT_CREDENTIALS,
    tokenFile: DEFAULT_TOKEN,
    excludeFile: DEFAULT_EXCLUDES,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--source":
        options.source = requireValue(args, ++index, "--source");
        break;
      case "--remote":
        options.remotePath = requireValue(args, ++index, "--remote");
        break;
      case "--credentials":
        options.credentialsFile = path.resolve(requireValue(args, ++index, "--credentials"));
        break;
      case "--token":
        options.tokenFile = path.resolve(requireValue(args, ++index, "--token"));
        break;
      case "--exclude-from":
        options.excludeFile = path.resolve(requireValue(args, ++index, "--exclude-from"));
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.source = path.resolve(arg);
        break;
    }
  }

  return options;
}

function requireValue(args, index, flagName) {
  if (index >= args.length) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return args[index];
}

function printHelp() {
  console.log(`Usage: node sync-todo.js [source-dir] [options]

Options:
  --remote DRIVE_PATH         Drive folder path to sync into (default: ${DEFAULT_REMOTE_PATH})
  --credentials FILE          OAuth client credentials JSON (default: ${DEFAULT_CREDENTIALS})
  --token FILE                Saved OAuth token JSON (default: ${DEFAULT_TOKEN})
  --exclude-from FILE         Exclude file patterns (default: ${DEFAULT_EXCLUDES})
  --dry-run                   Preview actions without uploading
  --help, -h                  Show this help
`);
}

async function loadExcludeRules(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      const pattern = negate ? line.slice(1) : line;
      return { negate, pattern, matcher: buildMatcher(pattern) };
    });
}

function buildMatcher(pattern) {
  const normalized = pattern.replace(/\\/g, "/");

  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return (relativePath, baseName) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}/`) || baseName === prefix;
  }

  const hasWildcard = normalized.includes("*");
  if (!normalized.includes("/")) {
    if (!hasWildcard) {
      return (relativePath, baseName) => relativePath === normalized || baseName === normalized;
    }

    const regex = globToRegex(normalized);
    return (_relativePath, baseName) => regex.test(baseName);
  }

  const regex = globToRegex(normalized);
  return (relativePath) => regex.test(relativePath);
}

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexBody = escaped.replace(/\*/g, "[^/]*");
  return new RegExp(`^${regexBody}$`);
}

function isIgnored(relativePath, rules) {
  const normalized = relativePath.replace(/\\/g, "/");
  const baseName = path.posix.basename(normalized);
  let ignored = false;

  for (const rule of rules) {
    if (rule.matcher(normalized, baseName)) {
      ignored = !rule.negate;
    }
  }

  return ignored;
}

async function collectLocalTree(rootDir, excludeRules) {
  const directories = [];
  const files = [];

  async function visit(relativeDir) {
    const fullDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
    const entries = await fsp.readdir(fullDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, entry.name)
        : entry.name;

      if (isIgnored(relativePath, excludeRules)) {
        continue;
      }

      if (entry.isDirectory()) {
        directories.push(relativePath);
        await visit(relativePath);
        continue;
      }

      if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await visit("");
  return { directories, files };
}

async function authorize(credentialsFile, tokenFile) {
  const rawCredentials = JSON.parse(await fsp.readFile(credentialsFile, "utf8"));
  const config = rawCredentials.installed || rawCredentials.web;

  if (!config) {
    throw new Error("Unsupported Google credentials file. Expected 'installed' or 'web' keys.");
  }

  const redirectUri = pickRedirectUri(config.redirect_uris || []);
  const oauth2Client = new googleClient.auth.OAuth2(
    config.client_id,
    config.client_secret,
    redirectUri
  );

  if (fs.existsSync(tokenFile)) {
    oauth2Client.setCredentials(JSON.parse(await fsp.readFile(tokenFile, "utf8")));
    return oauth2Client;
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: DRIVE_SCOPE,
    prompt: "consent",
  });

  console.log("Open this URL in your browser and approve access:");
  console.log(authUrl);
  console.log("");
  console.log("After approval, paste the full redirect URL or just the code parameter below.");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const response = (await rl.question("Code or redirect URL: ")).trim();
  await rl.close();

  let code = response;
  try {
    const parsedUrl = new URL(response);
    code = parsedUrl.searchParams.get("code") || response;
  } catch {
    // Treat raw input as the code.
  }

  if (!code) {
    throw new Error("No authorization code was provided.");
  }

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  await fsp.writeFile(tokenFile, JSON.stringify(tokens, null, 2));
  console.log(`Saved OAuth token to ${tokenFile}`);
  return oauth2Client;
}

function pickRedirectUri(redirectUris) {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new Error("The credentials file does not contain any redirect URIs.");
  }

  return (
    redirectUris.find((uri) => uri.startsWith("http://127.0.0.1")) ||
    redirectUris.find((uri) => uri.startsWith("http://localhost")) ||
    redirectUris[0]
  );
}

async function ensureRemotePath(drive, remotePath, dryRun) {
  const parts = remotePath.split("/").map((part) => part.trim()).filter(Boolean);
  let parentId = "root";

  for (const part of parts) {
    parentId = await ensureChildFolder(drive, parentId, part, dryRun);
  }

  return parentId;
}

async function ensureChildFolder(drive, parentId, name, dryRun) {
  if (isDryRunId(parentId)) {
    console.log(`[dry-run] create folder ${name}`);
    return `dry-run-folder:${parentId}/${name}`;
  }

  const existing = await findChild(drive, parentId, name, DRIVE_FOLDER_MIME);
  if (existing) {
    return existing.id;
  }

  if (dryRun) {
    console.log(`[dry-run] create folder ${name}`);
    return `dry-run-folder:${parentId}/${name}`;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parentId],
    },
    fields: "id, name",
  });

  console.log(`Created folder ${name}`);
  return created.data.id;
}

async function uploadOrUpdateFile(drive, parentId, fileName, localPath, dryRun) {
  if (isDryRunId(parentId)) {
    console.log(`[dry-run] upload ${localPath}`);
    return;
  }

  const existing = await findChild(drive, parentId, fileName);
  const mimeType = guessMimeType(fileName);

  if (dryRun) {
    const verb = existing ? "update" : "upload";
    console.log(`[dry-run] ${verb} ${localPath}`);
    return;
  }

  if (existing) {
    await drive.files.update({
      fileId: existing.id,
      requestBody: { name: fileName },
      media: {
        mimeType,
        body: fs.createReadStream(localPath),
      },
      fields: "id, name",
    });
    console.log(`Updated ${localPath}`);
    return;
  }

  await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
    },
    media: {
      mimeType,
      body: fs.createReadStream(localPath),
    },
    fields: "id, name",
  });
  console.log(`Uploaded ${localPath}`);
}

async function findChild(drive, parentId, name, mimeType) {
  const queryParts = [
    `'${escapeQueryValue(parentId)}' in parents`,
    `name = '${escapeQueryValue(name)}'`,
    "trashed = false",
  ];

  if (mimeType) {
    queryParts.push(`mimeType = '${escapeQueryValue(mimeType)}'`);
  }

  const response = await drive.files.list({
    q: queryParts.join(" and "),
    fields: "files(id, name, mimeType)",
    pageSize: 10,
    supportsAllDrives: false,
  });

  return response.data.files?.[0] || null;
}

function escapeQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function isDryRunId(value) {
  return typeof value === "string" && value.startsWith("dry-run-folder:");
}

function guessMimeType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
