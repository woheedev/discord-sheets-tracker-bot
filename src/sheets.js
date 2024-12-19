import { google } from "googleapis";
import * as dotenv from "dotenv";
import chalk from "chalk";
import path from "path";

dotenv.config();

const SHEET_ID = "1jxGOQ54PM3ilWiML0ATNzwQlvCL5wiRnMRZLs1RWMYk";

// Reuse logger format from index.js
const Logger = {
  formatMessage: (type, msg) => `[${new Date().toISOString()}] ${type} ${msg}`,
  info: (msg) => console.log(chalk.blue(Logger.formatMessage("INFO", msg))),
  warn: (msg) => console.log(chalk.yellow(Logger.formatMessage("WARN", msg))),
  error: (msg) => console.log(chalk.red(Logger.formatMessage("ERROR", msg))),
};

async function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(process.cwd(), "credentials.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return auth.getClient();
}

export async function syncMembersToSheet(membersMap) {
  try {
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    // Convert map to array and prepare data for sheets
    const headers = [
      "Discord ID",
      "Username",
      "Guild",
      "Class",
      "Weapon Role",
      "Weapon Name",
      "Has Active Thread",
      "Last Updated",
    ];
    const members = Array.from(membersMap.values());
    const rows = members.map((member) => [
      member.discordId || "",
      member.username || "",
      member.guild || "",
      member.classCategory || "",
      member.weaponRole || "",
      member.weaponRoleName || "",
      member.hasActiveThread || false,
      member.lastUpdated || "",
    ]);

    // Clear existing data
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: "Members!A2:H",
    });

    // Update sheet
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Members!A1:H",
      valueInputOption: "RAW",
      requestBody: {
        values: [headers, ...rows],
      },
    });

    Logger.info(`Successfully synced ${members.length} members to sheet`);
  } catch (error) {
    Logger.error(`Failed to sync with Google Sheets: ${error.message}`);
    throw error;
  }
}
