const fsPromises = require("fs/promises");
const { google } = require("googleapis");
const { parse } = require("node-html-parser");
const core = require("@actions/core");
const matter = require("gray-matter");
const TurndownService = require("turndown");

const DOCUMENT_MIME_TYPE = "application/vnd.google-apps.document";
const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

async function main({ googleDriveFolderId, outputDirectoryPath }) {
  console.log(`[gdtm] starting: folderId=${googleDriveFolderId} outputDir=${outputDirectoryPath}`);

  const auth = new google.auth.GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
  const drive = google.drive({ auth, version: "v3" });
  const sheets = google.sheets({ auth, version: "v4" });

  console.log("[gdtm] listing files...");
  const files = await listFiles({ drive, googleDriveFolderId });
  console.log(`[gdtm] found ${files.length} file(s): ${files.map((f) => f.name).join(", ")}`);

  await createDirectory(outputDirectoryPath);
  console.log(`[gdtm] created directory ${outputDirectoryPath}`);

  for (const file of files) {
    console.log(`[gdtm] exporting ${file.name} (${file.mimeType})`);
    if (file.mimeType === SPREADSHEET_MIME_TYPE) {
      await exportSpreadsheet({ sheets, file, outputDirectoryPath });
    } else {
      await exportDocument({ drive, file, outputDirectoryPath });
    }
  }
  console.log("[gdtm] done");
}

async function createDirectory(directoryPath) {
  await fsPromises.mkdir(directoryPath, { recursive: true });
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\]/g, "-");
}

async function listFiles({ drive, googleDriveFolderId }) {
  const response = await drive.files.list({
    fields: "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 1000,
    q: `'${googleDriveFolderId}' in parents and (mimeType = '${DOCUMENT_MIME_TYPE}' or mimeType = '${SPREADSHEET_MIME_TYPE}')`,
  });
  return response.data.files;
}

// --- Google Docs -> Markdown ---

async function exportDocument({ drive, file, outputDirectoryPath }) {
  const response = await drive.files.export({ fileId: file.id, mimeType: "text/html" });
  const { body, title } = convertHtml(response.data);
  const filename = sanitizeFilename(file.name);
  await fsPromises.writeFile(
    `${outputDirectoryPath}/${filename}.md`,
    matter.stringify(body, { title })
  );
}

function convertHtml(html) {
  const root = parse(html);
  const bodyElement = root.querySelector("body");

  bodyElement.querySelectorAll("*[style]").forEach((element) => {
    element.removeAttribute("style");
  });
  bodyElement.querySelectorAll("*[id]").forEach((element) => {
    element.removeAttribute("id");
  });
  bodyElement.querySelectorAll("p").forEach((element) => {
    if (element.innerHTML === "<span></span>") {
      element.remove();
    }
  });
  bodyElement.querySelectorAll("span").forEach((element) => {
    element.replaceWith(...element.childNodes);
  });
  bodyElement.querySelectorAll("a[href]").forEach((element) => {
    const href = element.getAttribute("href");
    if (!href) {
      return;
    }
    try {
      const url = new URL(href);
      const q = url.searchParams.get("q");
      element.setAttribute("href", q);
    } catch {
      // Ignore invalid URL in href (e.g. `"#cmnt_ref1"`).
    }
  });

  const firstElement = bodyElement.querySelector("*");
  const title = firstElement.text;
  firstElement.remove();

  const markdown = new TurndownService().turndown(bodyElement.innerHTML);

  return {
    body: markdown,
    title,
  };
}

// --- Google Sheets -> CSV (one file per tab) ---

async function exportSpreadsheet({ sheets, file, outputDirectoryPath }) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: file.id,
    fields: "sheets.properties",
  });
  const tabs = metadata.data.sheets.map((sheet) => sheet.properties);

  const spreadsheetName = sanitizeFilename(file.name);
  const spreadsheetDirectoryPath = `${outputDirectoryPath}/${spreadsheetName}`;
  await createDirectory(spreadsheetDirectoryPath);

  for (const tab of tabs) {
    const valuesResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: file.id,
      range: tab.title,
    });
    const csv = rowsToCsv(valuesResponse.data.values || []);
    const tabName = sanitizeFilename(tab.title);
    await fsPromises.writeFile(`${spreadsheetDirectoryPath}/${tabName}.csv`, csv);
  }
}

function rowsToCsv(rows) {
  return rows.map((row) => row.map(escapeCsvField).join(",")).join("\n");
}

function escapeCsvField(field) {
  const value = field === undefined || field === null ? "" : String(field);
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

main({
  googleDriveFolderId: core.getInput("google_drive_folder_id"),
  outputDirectoryPath: core.getInput("output_directory_path"),
}).catch((err) => {
  console.error("[gdtm] FAILED:", err);
  core.setFailed(err.message || String(err));
});
