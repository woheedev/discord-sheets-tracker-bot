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
      "In-Game Name",
      "Guild",
      "Class",
      "Weapon Role",
      "Weapon Name",
      "Has Active Thread",
      "Last Updated",
    ];

    // Sort by guild then by ingame name
    const members = Array.from(membersMap.values()).sort((a, b) => {
      // Handle null/undefined guilds
      if (!a.guild) return 1;
      if (!b.guild) return -1;

      // First compare guilds
      const guildCompare = a.guild.localeCompare(b.guild);

      // If same guild, compare ingame names
      if (guildCompare === 0) {
        // Handle null ingame names
        if (!a.ingameName) return 1;
        if (!b.ingameName) return -1;
        return a.ingameName.localeCompare(b.ingameName);
      }

      return guildCompare;
    });

    const rows = members.map((member) => [
      member.discordId || "",
      member.username || "",
      member.ingameName || "",
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
      range: "Members!A2:I",
    });

    // Update sheet
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Members!A1:I",
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
