import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { Client as Appwrite, Databases } from "node-appwrite";
import * as dotenv from "dotenv";

import { syncMembersToSheet } from "./sheets.js";
import {
  validateIngameName,
  setIngameName,
  getUserData,
  getAllUserData,
  setShuttingDown,
} from "./utils/db.js";
import { Logger } from "./utils/logger.js";

dotenv.config();

// Basic validation
const requiredEnvVars = [
  "TOKEN",
  "APPWRITE_ENDPOINT",
  "APPWRITE_PROJECT_ID",
  "APPWRITE_API_KEY",
  "APPWRITE_DATABASE_ID",
  "APPWRITE_COLLECTION_ID",
];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
});

// Constants
const MAIN_SERVER_ID = "1309266911703334952";

const AUTHORIZED_ROLES = {
  LEADERSHIP: "1309271313398894643",
  OFFICER: "1309284427553312769",
};

const SYSTEM_ROLES = {
  NO_IGN: "1319882093756678175",
  NO_CLASS: "1319882096331853936",
  NO_THREAD: "1319882021518184520",
};

// Initialize Appwrite
const appwrite = new Appwrite()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(appwrite);

const commands = [
  new SlashCommandBuilder()
    .setName("ign")
    .setDescription("Set a user's in-game name")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The Discord user to set IGN for")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("The in-game name to set")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(15)
    ),
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("Show member information")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The Discord user to get info for")
        .setRequired(true)
    ),
];

async function updateSystemRoles(
  member,
  { hasClassRole, hasIngameName, hasThread }
) {
  try {
    // Create a map of conditions to role IDs
    const roleConditions = {
      [SYSTEM_ROLES.NO_IGN]: !hasIngameName,
      [SYSTEM_ROLES.NO_CLASS]: !hasClassRole,
      [SYSTEM_ROLES.NO_THREAD]: !hasThread,
    };

    const currentRoles = Array.from(member.roles.cache.keys());
    const rolesToAdd = [];
    const rolesToRemove = [];

    // Check each system role
    Object.entries(roleConditions).forEach(([roleId, shouldHaveRole]) => {
      const hasRole = currentRoles.includes(roleId);
      if (shouldHaveRole && !hasRole) {
        rolesToAdd.push(roleId);
      } else if (!shouldHaveRole && hasRole) {
        rolesToRemove.push(roleId);
      }
    });

    // Batch update roles if changes needed
    if (rolesToAdd.length > 0) {
      await member.roles.add(rolesToAdd).catch((error) => {
        Logger.error(`Failed to add roles to ${member.id}: ${error.message}`);
      });
    }

    if (rolesToRemove.length > 0) {
      await member.roles.remove(rolesToRemove).catch((error) => {
        Logger.error(
          `Failed to remove roles from ${member.id}: ${error.message}`
        );
      });
    }
  } catch (error) {
    Logger.error(
      `Error updating system roles for ${member.id}: ${error.message}`
    );
  }
}

async function syncMembers() {
  try {
    const mainGuild = await client.guilds.fetch(MAIN_SERVER_ID);
    const members = await mainGuild.members.fetch();
    const memberArray = Array.from(members.values());

    // Get all user data in one query
    const userDataMap = await getAllUserData(
      databases,
      memberArray.map((m) => m.id)
    );

    // If userDataMap is null, it means there was a database error
    if (userDataMap === null) {
      Logger.error("Failed to fetch user data from Appwrite, aborting sync");
      return;
    }

    // Process all members with the batch data
    await Promise.all(
      memberArray.map(async (member) => {
        try {
          const userData = userDataMap.get(member.id);

          // Handle member cleanup or update
          if (!userData?.guild) {
            await memberMapper.cleanupNonGuildMember(member);
            return;
          }

          // Update system roles
          await updateSystemRoles(member, {
            hasClassRole: !!userData.class,
            hasIngameName: !!userData.ingameName,
            hasThread: userData.hasThread,
          });

          // Update tracking
          memberMapper.members.set(member.id, {
            discordId: member.id,
            username: member.user?.username || "Unknown",
            ingameName: userData.ingameName,
            guild: userData.guild,
            classCategory: userData.class,
            weaponRole: userData.weaponNames ? "EXISTS" : null,
            weaponRoleName: userData.weaponNames,
            hasActiveThread: userData.hasThread,
            lastUpdated:
              userData.$updatedAt ||
              userData.$createdAt ||
              new Date().toISOString(),
          });
        } catch (error) {
          Logger.error(
            `Error processing member ${member.id}: ${error.message}\n${error.stack}`
          );
        }
      })
    );

    Logger.info(`Synced ${memberMapper.getAllMembers().length} guild members`);
  } catch (error) {
    Logger.error(`Error in syncMembers: ${error.message}\n${error.stack}`);
    throw error;
  }
}

// Guild Member mapper
class GuildMemberMapper {
  constructor() {
    this.members = new Map();
  }

  getMember(memberId) {
    return this.members.get(memberId);
  }

  getAllMembers() {
    return Array.from(this.members.values());
  }

  async processMember(member) {
    if (!member?.id || !member?.guild?.id === MAIN_SERVER_ID) {
      return;
    }

    try {
      const userData = await getUserData(databases, member.id);

      // Handle member cleanup or update
      if (!userData?.guild) {
        await this.cleanupNonGuildMember(member);
        return;
      }

      await this.updateMember(member, userData);
    } catch (error) {
      Logger.error(
        `Error processing member ${member.id}: ${error.message}\n${error.stack}`
      );
    }
  }

  async updateMember(member, userData) {
    try {
      // Update system roles first
      await updateSystemRoles(member, {
        hasClassRole: !!userData.class,
        hasIngameName: !!userData.ingameName,
        hasThread: userData.hasThread,
      });

      // Then update our tracking
      this.members.set(member.id, {
        discordId: member.id,
        username: member.user?.username || "Unknown",
        ingameName: userData.ingameName,
        guild: userData.guild,
        classCategory: userData.class,
        weaponRole: userData.weaponNames ? "EXISTS" : null,
        weaponRoleName: userData.weaponNames,
        hasActiveThread: userData.hasThread,
        lastUpdated:
          userData.$updatedAt ||
          userData.$createdAt ||
          new Date().toISOString(),
      });
    } catch (error) {
      Logger.error(
        `Error updating member ${member.id}: ${error.message}\n${error.stack}`
      );
    }
  }

  async cleanupNonGuildMember(member) {
    try {
      const hasSystemRoles = Object.values(SYSTEM_ROLES).some((roleId) =>
        member.roles.cache.has(roleId)
      );

      if (hasSystemRoles) {
        await member.roles
          .remove(Object.values(SYSTEM_ROLES))
          .catch((error) => {
            Logger.error(
              `Failed to remove system roles from ${member.id}: ${error.message}`
            );
          });
      }

      if (this.members.has(member.id)) {
        this.members.delete(member.id);
        Logger.info(`Removed ${member.user?.tag || member.id} from tracking`);
      }
    } catch (error) {
      Logger.error(
        `Error cleaning up non-guild member ${member.id}: ${error.message}`
      );
    }
  }
}

// Bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const memberMapper = new GuildMemberMapper();

// Cleanup function for graceful shutdown
async function cleanup() {
  Logger.info("Starting cleanup...");

  // Set shutdown state first
  setShuttingDown(true);

  // Clear sync interval
  if (syncInterval) {
    clearInterval(syncInterval);
    Logger.info("Cleared sync interval");
  }

  // Skip final sync during shutdown to prevent database errors
  Logger.info("Skipping final sync during shutdown");

  // Destroy the client
  if (client) {
    client.destroy();
    Logger.info("Discord client destroyed");
  }
}

// Handle process termination
process.on("SIGTERM", async () => {
  Logger.info("SIGTERM received. Starting graceful shutdown...");
  await cleanup();
  process.exit(0);
});

process.on("SIGINT", async () => {
  Logger.info("SIGINT received. Starting graceful shutdown...");
  await cleanup();
  process.exit(0);
});

// Handle unhandled rejections and exceptions
process.on("unhandledRejection", (error) => {
  Logger.error(`Unhandled promise rejection: ${error.message}\n${error.stack}`);
});

process.on("uncaughtException", (error) => {
  Logger.error(`Uncaught exception: ${error.message}\n${error.stack}`);
  // Attempt cleanup and exit
  cleanup().finally(() => process.exit(1));
});

// Event handlers
client.once("ready", async () => {
  Logger.info(`Bot logged in as ${client.user.tag}`);
  try {
    await client.application.commands.set(commands);
    startPeriodicSync(); // This will do the initial sync
    Logger.info("Initial setup completed successfully");
  } catch (error) {
    Logger.error(`Error during bot initialization: ${error.message}`);
    process.exit(1); // Exit if initialization fails
  }
});

// Add error handler for the Discord client
client.on("error", (error) => {
  Logger.error(`Discord client error: ${error.message}\n${error.stack}`);
});

client.on("shardError", (error) => {
  Logger.error(`Discord websocket error: ${error.message}\n${error.stack}`);
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  if (newMember.guild.id === MAIN_SERVER_ID) {
    // Only process if role changes weren't from our system roles
    const systemRoleChange = Object.values(SYSTEM_ROLES).some(
      (roleId) =>
        oldMember.roles.cache.has(roleId) !== newMember.roles.cache.has(roleId)
    );

    if (!systemRoleChange) {
      await memberMapper.processMember(newMember);
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case "ign":
        // Check authorization
        const hasAuthorizedRole = interaction.member.roles.cache.hasAny(
          ...Object.values(AUTHORIZED_ROLES)
        );
        if (!hasAuthorizedRole) {
          await interaction.reply({
            content: "You don't have permission to use this command.",
            ephemeral: true,
          });
          return;
        }

        const targetUser = interaction.options.getUser("user");
        const newName = interaction.options.getString("name");

        // Validate name
        const validation = validateIngameName(newName);
        if (!validation.valid) {
          await interaction.reply({
            content: validation.error,
            ephemeral: true,
          });
          return;
        }

        try {
          const guild = await client.guilds.fetch(MAIN_SERVER_ID);
          const member = await guild.members.fetch(targetUser.id);

          // Check if target has guild role
          const userData = await getUserData(databases, targetUser.id);

          if (!userData?.guild) {
            await interaction.reply({
              content: "The target user must be in one of our guilds.",
              ephemeral: true,
            });
            return;
          }

          // Save and update
          await setIngameName(databases, targetUser.id, validation.value);
          await memberMapper.processMember(member);

          await interaction.reply({
            content: `Set ${targetUser}'s in-game name to: ${validation.value}`,
            ephemeral: true,
          });
        } catch (error) {
          Logger.error(`Error in /ign command: ${error.message}`);
          await interaction.reply({
            content:
              "There was an error processing the command. Please try again.",
            ephemeral: true,
          });
        }
        break;
      case "info":
        // Check authorization
        const userData = await getUserData(databases, interaction.member.id);

        if (!userData?.guild) {
          await interaction.reply({
            content: "You must be in one of our guilds to use this command.",
            ephemeral: true,
          });
          return;
        }

        try {
          const targetUser = interaction.options.getUser("user");
          const memberInfo = memberMapper.getMember(targetUser.id);
          const guildMember = interaction.guild.members.cache.get(
            targetUser.id
          );
          const displayName = guildMember?.nickname || targetUser.username;

          if (!memberInfo) {
            await interaction.reply({
              content:
                "No information found for this user. They may not be in any of our guilds.",
              ephemeral: true,
            });
            return;
          }

          const infoEmbed = {
            color: 0xc27d0f,
            title: `Member Info: ${displayName}`,
            fields: [
              // Row 1
              {
                name: "In-Game Name",
                value: memberInfo.ingameName || "Not Set",
                inline: true,
              },
              {
                name: "Guild",
                value: memberInfo.guild || "None",
                inline: true,
              },
              {
                name: "\u200b",
                value: "\u200b",
                inline: true,
              },
              // Row 2
              {
                name: "Class",
                value: memberInfo.classCategory || "Not Set",
                inline: true,
              },
              {
                name: "Weapon",
                value: memberInfo.weaponRoleName || "Not Set",
                inline: true,
              },
              {
                name: "\u200b",
                value: "\u200b",
                inline: true,
              },
            ],
            timestamp: new Date(memberInfo.lastUpdated),
            footer: { text: "Last Updated" },
          };

          await interaction.reply({
            embeds: [infoEmbed],
          });
        } catch (error) {
          Logger.error(`Error in /info command: ${error.message}`);
          await interaction.reply({
            content:
              "There was an error processing the command. Please try again.",
            ephemeral: true,
          });
        }
        break;
    }
  }
});

client.on("guildMemberRemove", async (member) => {
  if (member.guild.id === MAIN_SERVER_ID) {
    // Check if member was tracked
    if (memberMapper.members.has(member.id)) {
      // Remove from our tracking
      memberMapper.members.delete(member.id);
      Logger.info(`Removed ${member.user.tag} (${member.id}) from tracking`);
    }
  }
});

// Create a more reliable sync with error handling and retries
async function syncWithRetry() {
  const maxRetries = 3;
  let retryCount = 0;

  async function attemptSync() {
    try {
      // First fetch fresh data
      await syncMembers();

      // Only proceed with sheet sync if we have valid member data
      if (memberMapper.getAllMembers().length > 0) {
        await syncMembersToSheet(memberMapper.members);
      } else {
        Logger.error("Skipping sheet sync due to empty member data");
        return;
      }

      if (retryCount > 0) {
        Logger.info(`Successfully synced after ${retryCount} retries`);
      }
    } catch (error) {
      retryCount++;
      Logger.error(
        `Failed to sync members (attempt ${retryCount}/${maxRetries}): ${error.message}`
      );

      if (retryCount < maxRetries) {
        Logger.info(`Retrying sync in 3 seconds...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return attemptSync();
      } else {
        Logger.error(`Failed to sync after ${maxRetries} attempts`);
      }
    }
  }

  await attemptSync();
}

// Periodic sync with error handling
let syncInterval;
const startPeriodicSync = () => {
  // Clear any existing interval
  if (syncInterval) {
    clearInterval(syncInterval);
  }

  // Set up new interval (1 minute)
  syncInterval = setInterval(() => {
    syncWithRetry().catch((error) => {
      Logger.error(`Periodic sync failed: ${error.message}`);
    });
  }, 10 * 60 * 1000); // Every 10 minutes

  // Initial sync
  syncWithRetry().catch((error) => {
    Logger.error(`Initial periodic sync failed: ${error.message}`);
  });
};

client.login(process.env.TOKEN);
