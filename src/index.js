import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
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
  getReviewData,
  updateReviewData,
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
  "APPWRITE_REVIEW_COLLECTION_ID",
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

// Weapon reviewer role mappings
const WEAPON_REVIEWER_ROLES = {
  "1323121646336479253": { primary: "SNS", secondary: "GS" },
  "1323121710861516901": { primary: "SNS", secondary: "Wand" },
  "1323121684147994756": { primary: "SNS", secondary: "Dagger" },
  "1324201709886509107": { primary: "SNS", secondary: "Spear" },
  "1323122250995597442": { primary: "Wand", secondary: "Bow" },
  "1323122341995348078": { primary: "Wand", secondary: "Staff" },
  "1323122486396715101": { primary: "Wand", secondary: "SNS" },
  "1323122572174299160": { primary: "Wand", secondary: "Dagger" },
  "1323122828802920479": { primary: "Staff", secondary: "Bow" },
  "1323122917466181672": { primary: "Staff", secondary: "Dagger" },
  "1323122947040219166": { primary: "Bow", secondary: "Dagger" },
  "1323123053793640560": { primary: "GS", secondary: "Dagger" },
  "1323123139500048384": { primary: "Spear", secondary: "Dagger" },
  "1324201778190880799": { primary: "Spear", secondary: "Other" },
  "1323123176405729393": { primary: "Dagger", secondary: "Wand" },
  "1323123243959451671": { primary: "Xbow", secondary: "Dagger" },
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
  new SlashCommandBuilder()
    .setName("user")
    .setDescription("Find Discord users by in-game name")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Full or partial in-game name to search for")
        .setRequired(true)
        .setMinLength(2)
    ),
  new SlashCommandBuilder()
    .setName("ticketupdate")
    .setDescription("Update a member's ticket information")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The Discord user to update")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("has_vod")
        .setDescription("Set if user has VOD")
        .addChoices(
          { name: "Yes", value: "true" },
          { name: "No", value: "false" }
        )
    )
    .addBooleanOption((option) =>
      option
        .setName("update_vod_date")
        .setDescription("Update VOD check date to current time")
    )
    .addStringOption((option) =>
      option
        .setName("gear_checked")
        .setDescription("Set if gear has been checked")
        .addChoices(
          { name: "Yes", value: "true" },
          { name: "No", value: "false" }
        )
    )
    .addBooleanOption((option) =>
      option
        .setName("update_gear_date")
        .setDescription("Update gear check date to current time")
    )
    .addIntegerOption((option) =>
      option
        .setName("gear_score")
        .setDescription("Set the user's Combat Power (0-5000)")
        .setMinValue(0)
        .setMaxValue(5000)
    )
    .addStringOption((option) =>
      option
        .setName("notes")
        .setDescription("Update notes for the member")
        .setMaxLength(500)
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

  client.user.setPresence({
    activities: [{ name: "Five" }],
    status: "online",
  });

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
            flags: MessageFlags.Ephemeral,
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
            flags: MessageFlags.Ephemeral,
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
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // Save and update
          await setIngameName(databases, targetUser.id, validation.value);
          await memberMapper.processMember(member);

          await interaction.reply({
            content: `Set ${targetUser}'s in-game name to: ${validation.value}`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (error) {
          Logger.error(`Error in /ign command: ${error.message}`);
          await interaction.reply({
            content:
              "There was an error processing the command. Please try again.",
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      case "info":
        // Check authorization
        const userData = await getUserData(databases, interaction.member.id);

        if (!userData?.guild) {
          await interaction.reply({
            content: "You must be in one of our guilds to use this command.",
            flags: MessageFlags.Ephemeral,
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
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // Get review data
          const reviewData = await getReviewData(databases, targetUser.id);

          // Check if user can see notes (has authorized role or is a weapon reviewer)
          const canSeeNotes =
            interaction.member.roles.cache.hasAny(
              ...Object.values(AUTHORIZED_ROLES)
            ) ||
            interaction.member.roles.cache.some(
              (role) => WEAPON_REVIEWER_ROLES[role.id]
            );

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
              // Row 3 - Review Ticket and Combat Power
              {
                name: "Has Review Ticket",
                value: memberInfo.hasActiveThread ? "Yes" : "No",
                inline: true,
              },
              {
                name: "Combat Power",
                value:
                  reviewData.gear_score > 0
                    ? reviewData.gear_score.toString()
                    : "Not Set",
                inline: true,
              },
              {
                name: "\u200b",
                value: "\u200b",
                inline: true,
              },
              // Row 4 - VOD Status
              {
                name: "Has VOD",
                value: reviewData.has_vod ? "Yes" : "No",
                inline: true,
              },
              {
                name: "Last VOD Check",
                value: reviewData.vod_check_date || "Never",
                inline: true,
              },
              {
                name: "\u200b",
                value: "\u200b",
                inline: true,
              },
              // Row 5 - Gear Status
              {
                name: "Gear Checked",
                value: reviewData.gear_checked ? "Yes" : "No",
                inline: true,
              },
              {
                name: "Last Gear Check",
                value: reviewData.gear_check_date || "Never",
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

          // Add notes field if user has permission and notes exist
          if (canSeeNotes && reviewData.notes?.trim()) {
            infoEmbed.fields.push({
              name: "Notes",
              value: reviewData.notes,
              inline: false,
            });
          }

          await interaction.reply({
            embeds: [infoEmbed],
            flags: MessageFlags.Ephemeral,
          });
        } catch (error) {
          Logger.error(`Error in /info command: ${error.message}`);
          await interaction.reply({
            content:
              "There was an error processing the command. Please try again.",
            flags: MessageFlags.Ephemeral,
          });
        }
        break;

      case "user":
        // Check authorization (same as info command)
        const userCommandData = await getUserData(
          databases,
          interaction.member.id
        );

        if (!userCommandData?.guild) {
          await interaction.reply({
            content: "You must be in one of our guilds to use this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        try {
          const searchName = interaction.options
            .getString("name")
            .toLowerCase();
          const allMembers = memberMapper.getAllMembers();

          // Filter members that have an IGN containing the search term
          const matchingMembers = allMembers.filter(
            (member) =>
              member.ingameName &&
              member.ingameName.toLowerCase().includes(searchName)
          );

          if (matchingMembers.length === 0) {
            await interaction.reply({
              content: "No players found with that in-game name.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // Sort by exact match first, then alphabetically
          matchingMembers.sort((a, b) => {
            const aExact = a.ingameName.toLowerCase() === searchName;
            const bExact = b.ingameName.toLowerCase() === searchName;
            if (aExact && !bExact) return -1;
            if (!aExact && bExact) return 1;
            return a.ingameName.localeCompare(b.ingameName);
          });

          // Format the response
          const matchList = matchingMembers
            .map((member) => {
              const discordUser = interaction.guild.members.cache.get(
                member.discordId
              );
              return `<@${member.discordId}> - ${member.ingameName}`;
            })
            .join("\n");

          const response = `Found ${matchingMembers.length} player${
            matchingMembers.length === 1 ? "" : "s"
          }:\n${matchList}`;

          await interaction.reply({
            content: response,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { users: [] }, // Prevent mentions
          });
        } catch (error) {
          Logger.error(`Error in /user command: ${error.message}`);
          await interaction.reply({
            content:
              "There was an error processing the command. Please try again.",
            flags: MessageFlags.Ephemeral,
          });
        }
        break;

      case "ticketupdate":
        try {
          const targetUser = interaction.options.getUser("user");

          // Get target user's member info
          const targetMemberInfo = memberMapper.getMember(targetUser.id);
          if (!targetMemberInfo) {
            await interaction.reply({
              content: "Target user not found in any of our guilds.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // Check if user is in a guild
          if (!targetMemberInfo.guild) {
            await interaction.reply({
              content:
                "Target user must be in a guild to update their information.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // Check if user has an open thread
          if (!targetMemberInfo.hasActiveThread) {
            await interaction.reply({
              content:
                "Target user must have an open review thread to update their information.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // Check authorization - only weapon reviewers can use this command
          const hasWeaponReviewerRole =
            targetMemberInfo.weaponRoleName &&
            interaction.member.roles.cache.some((role) => {
              // Check if this role is a weapon reviewer role
              const reviewerRole = WEAPON_REVIEWER_ROLES[role.id];
              if (!reviewerRole) return false;

              // Get target's primary and secondary weapons
              const [targetPrimary, targetSecondary] =
                targetMemberInfo.weaponRoleName.split("/").map((w) => w.trim());

              // Check if weapons match exactly (both primary and secondary)
              return (
                targetPrimary === reviewerRole.primary &&
                targetSecondary === reviewerRole.secondary
              );
            });

          if (!hasWeaponReviewerRole) {
            await interaction.reply({
              content:
                "You must have a weapon lead role matching the target user's weapons to use this command.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const updates = {};

          // Collect all provided options
          const hasVod = interaction.options.getString("has_vod");
          const updateVodDate =
            interaction.options.getBoolean("update_vod_date");
          const gearChecked = interaction.options.getString("gear_checked");
          const updateGearDate =
            interaction.options.getBoolean("update_gear_date");
          const gearScore = interaction.options.getInteger("gear_score");
          const notes = interaction.options.getString("notes");

          // Only include provided options in updates
          if (hasVod !== null) updates.has_vod = hasVod;
          if (updateVodDate !== null) updates.update_vod_date = updateVodDate;
          if (gearChecked !== null) updates.gear_checked = gearChecked;
          if (updateGearDate !== null)
            updates.update_gear_date = updateGearDate;
          if (gearScore !== null) updates.gear_score = gearScore;
          if (notes !== null) updates.notes = notes;

          // Check if any updates were provided
          if (Object.keys(updates).length === 0) {
            await interaction.reply({
              content: "No updates were provided.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // Update the data
          try {
            await updateReviewData(databases, targetUser.id, updates);

            // Get the updated data to show in response
            const updatedData = await getReviewData(databases, targetUser.id);
            const guildMember = interaction.guild.members.cache.get(
              targetUser.id
            );
            const displayName = guildMember?.nickname || targetUser.username;

            // Create info embed with updated data
            const infoEmbed = {
              color: 0xc27d0f,
              title: `Member Info: ${displayName}`,
              fields: [
                // Row 1
                {
                  name: "In-Game Name",
                  value: targetMemberInfo.ingameName || "Not Set",
                  inline: true,
                },
                {
                  name: "Guild",
                  value: targetMemberInfo.guild || "None",
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
                  value: targetMemberInfo.classCategory || "Not Set",
                  inline: true,
                },
                {
                  name: "Weapon",
                  value: targetMemberInfo.weaponRoleName || "Not Set",
                  inline: true,
                },
                {
                  name: "\u200b",
                  value: "\u200b",
                  inline: true,
                },
                // Row 3 - Review Ticket and Combat Power
                {
                  name: "Has Review Ticket",
                  value: targetMemberInfo.hasActiveThread ? "Yes" : "No",
                  inline: true,
                },
                {
                  name: "Combat Power",
                  value:
                    updatedData.gear_score > 0
                      ? updatedData.gear_score.toString()
                      : "Not Set",
                  inline: true,
                },
                {
                  name: "\u200b",
                  value: "\u200b",
                  inline: true,
                },
                // Row 4 - VOD Status
                {
                  name: "Has VOD",
                  value: updatedData.has_vod ? "Yes" : "No",
                  inline: true,
                },
                {
                  name: "Last VOD Check",
                  value: updatedData.vod_check_date || "Never",
                  inline: true,
                },
                {
                  name: "\u200b",
                  value: "\u200b",
                  inline: true,
                },
                // Row 5 - Gear Status
                {
                  name: "Gear Checked",
                  value: updatedData.gear_checked ? "Yes" : "No",
                  inline: true,
                },
                {
                  name: "Last Gear Check",
                  value: updatedData.gear_check_date || "Never",
                  inline: true,
                },
                {
                  name: "\u200b",
                  value: "\u200b",
                  inline: true,
                },
              ],
              timestamp: new Date(),
              footer: { text: "Last Updated" },
            };

            // Add notes field if user has permission and notes exist
            if (
              (hasAuthorizedRole || hasWeaponReviewerRole) &&
              updatedData.notes?.trim()
            ) {
              infoEmbed.fields.push({
                name: "Notes",
                value: updatedData.notes,
                inline: false,
              });
            }

            // Create list of what was updated
            const changes = [];
            if (hasVod !== null) changes.push("Has VOD");
            if (updateVodDate) changes.push("VOD Check Date");
            if (gearChecked !== null) changes.push("Gear Checked");
            if (updateGearDate) changes.push("Gear Check Date");
            if (gearScore !== null) changes.push("Combat Power");
            if (notes !== null) changes.push("Notes");

            await interaction.reply({
              content: `Updated fields: ${changes.join(", ")}`,
              embeds: [infoEmbed],
              flags: MessageFlags.Ephemeral,
            });
          } catch (error) {
            // Handle specific error cases
            if (error.message.includes("VOD is not marked as available")) {
              await interaction.reply({
                content:
                  "Cannot update VOD check date when VOD is not marked as available. Please set 'Has VOD' to Yes first.",
                flags: MessageFlags.Ephemeral,
              });
              return;
            }
            if (error.message.includes("gear is not marked as checked")) {
              await interaction.reply({
                content:
                  "Cannot update gear check date when gear is not marked as checked. Please set 'Gear Checked' to Yes first.",
                flags: MessageFlags.Ephemeral,
              });
              return;
            }

            // Handle unexpected errors
            Logger.error(`Error in /ticketupdate command: ${error.message}`);
            await interaction.reply({
              content:
                "There was an error processing the command. Please try again.",
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch (error) {
          Logger.error(`Error in /ticketupdate command: ${error.message}`);
          await interaction.reply({
            content:
              "There was an error processing the command. Please try again.",
            flags: MessageFlags.Ephemeral,
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
