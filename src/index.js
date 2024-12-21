import {
  Client,
  GatewayIntentBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import * as dotenv from "dotenv";
import chalk from "chalk";
import debounce from "lodash/debounce";

import { syncMembersToSheet } from "./sheets.js";
import { initializeDb, saveIngameName, getIngameName } from "./db.js";

dotenv.config();

// Basic validation
const requiredEnvVars = ["TOKEN"];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
});

// Logger utility
const Logger = {
  formatMessage: (type, msg) => `[${new Date().toISOString()}] ${type} ${msg}`,
  info: (msg) => console.log(chalk.blue(Logger.formatMessage("INFO", msg))),
  warn: (msg) => console.log(chalk.yellow(Logger.formatMessage("WARN", msg))),
  error: (msg) => console.log(chalk.red(Logger.formatMessage("ERROR", msg))),
};

// Constants
const MAIN_SERVER_ID = "1309266911703334952";
const INGAME_NAME_CHANNEL = "1309279173566664714";

const GUILD_ROLES = {
  TSUNAMI: { id: "1315072149173698580", name: "Tsunami" },
  HURRICANE: { id: "1315071746721976363", name: "Hurricane" },
  AVALANCHE: { id: "1314816353797935214", name: "Avalanche" },
  HAILSTORM: { id: "1315072176839327846", name: "Hailstorm" },
};

const AUTHORIZED_ROLES = {
  LEADERSHIP: "1309271313398894643",
  OFFICER: "1309284427553312769",
};

const CLASS_CATEGORIES = {
  TANK: {
    id: "Tank",
    roleIds: [
      "1315087293408739401",
      "1315087506105958420",
      "1315087805650571366",
    ],
  },
  HEALER: {
    id: "Healer",
    roleIds: [
      "1315090429233991812",
      "1315090436703912058",
      "1315090738500993115",
      "1315091030248263690",
    ],
  },
  RANGED: {
    id: "Ranged",
    roleIds: [
      "1315091763370786898",
      "1315091966303797248",
      "1315092313755881573",
    ],
  },
  MELEE: {
    id: "Melee",
    roleIds: ["1315092445930717194", "1315093022483939338"],
  },
  BOMBER: {
    id: "Bomber",
    roleIds: ["1315092575509807215", "1315092852690128907"],
  },
};

const REVIEW_CHANNELS = {
  tank: { channelId: "1316181886308978788" },
  healer: { channelId: "1316182043012632626" },
  ranged: { channelId: "1316182011362414693" },
  melee: { channelId: "1316181992177668237" },
  bomber: { channelId: "1316182023433486427" },
};

const SYSTEM_ROLES = {
  NO_IGN: "1319882093756678175",
  NO_CLASS: "1319882096331853936",
  NO_THREAD: "1319882021518184520",
};

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
    const currentRoles = Array.from(member.roles.cache.keys());
    const rolesToAdd = [];
    const rolesToRemove = [];

    // Calculate role changes
    if (!hasIngameName) {
      !currentRoles.includes(SYSTEM_ROLES.NO_IGN) &&
        rolesToAdd.push(SYSTEM_ROLES.NO_IGN);
    } else {
      currentRoles.includes(SYSTEM_ROLES.NO_IGN) &&
        rolesToRemove.push(SYSTEM_ROLES.NO_IGN);
    }

    if (!hasClassRole) {
      !currentRoles.includes(SYSTEM_ROLES.NO_CLASS) &&
        rolesToAdd.push(SYSTEM_ROLES.NO_CLASS);
    } else {
      currentRoles.includes(SYSTEM_ROLES.NO_CLASS) &&
        rolesToRemove.push(SYSTEM_ROLES.NO_CLASS);
    }

    if (!hasThread) {
      !currentRoles.includes(SYSTEM_ROLES.NO_THREAD) &&
        rolesToAdd.push(SYSTEM_ROLES.NO_THREAD);
    } else {
      currentRoles.includes(SYSTEM_ROLES.NO_THREAD) &&
        rolesToRemove.push(SYSTEM_ROLES.NO_THREAD);
    }

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

async function updateMemberFromThread(thread) {
  const userId = threadManager.getUserIdFromThreadName(thread.name);
  if (userId) {
    const member = await thread.guild.members.fetch(userId).catch(() => null);
    if (member) {
      await memberMapper.processMember(member);
      debouncedSync();
    }
  }
}

async function syncMembers() {
  const mainGuild = await client.guilds.fetch(MAIN_SERVER_ID);
  const members = await mainGuild.members.fetch();

  await Promise.all(
    Array.from(members.values()).map((member) =>
      memberMapper.processMember(member)
    )
  );

  Logger.info(`Synced ${memberMapper.getAllMembers().length} guild members`);
  await debouncedSync();
}

async function hasActiveThread(member) {
  return threadManager.hasActiveThread(member.id);
}

async function createIngameNameMessage(channel) {
  // Check for existing message with button
  const messages = await channel.messages.fetch();
  const existingMessage = messages.find(
    (msg) => msg.author.id === client.user.id && msg.components.length > 0
  );

  if (existingMessage) {
    Logger.info("Ingame name message already exists");
    return;
  }

  const button = new ButtonBuilder()
    .setCustomId("setIngameName")
    .setLabel("Set/Update In-Game Name")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);

  const content =
    "Please set your in-game name for Hazardous guild records:\n\n*Please ensure the name matches your in-game character name exactly*";

  await channel.send({
    content,
    components: [row],
  });

  Logger.info("Created new ingame name message");
}

function createIngameNameModal(existingName = "") {
  const trimmedName = existingName.trim();
  const modal = new ModalBuilder()
    .setCustomId("ingameNameModal")
    .setTitle("What is your TnL in-game name?");

  const nameInput = new TextInputBuilder()
    .setCustomId("ingameNameInput")
    .setLabel("In-Game Name:")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(15);

  if (trimmedName.length >= 2 && trimmedName.length <= 15) {
    nameInput.setValue(trimmedName);
  }

  modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
  return modal;
}

class ThreadManager {
  constructor() {
    this.activeThreads = new Map(); // userId -> threadId
  }

  async initializeCache(guild) {
    this.activeThreads.clear();
    for (const channelInfo of Object.values(REVIEW_CHANNELS)) {
      const channel = await guild.channels.fetch(channelInfo.channelId);
      if (!channel) continue;

      const [activeThreads, archivedThreads] = await Promise.all([
        channel.threads.fetchActive(),
        channel.threads.fetchArchived({
          fetchAll: true,
          type: "private",
        }),
      ]);

      // Process both active and archived threads
      for (const collection of [
        activeThreads.threads,
        archivedThreads.threads,
      ]) {
        for (const thread of collection.values()) {
          // Only track threads that are not archived and not locked
          if (!thread.archived && !thread.locked) {
            const userId = this.getUserIdFromThreadName(thread.name);
            if (userId) {
              this.activeThreads.set(userId, thread.id);
            }
          }
        }
      }
    }
    Logger.info(
      `Initialized thread cache with ${this.activeThreads.size} active entries`
    );
  }

  getUserIdFromThreadName(threadName) {
    const match = threadName.match(/\[(\d+)\]$/);
    return match ? match[1] : null;
  }

  hasActiveThread(userId) {
    return this.activeThreads.has(userId);
  }

  addThread(thread) {
    if (!thread.archived && !thread.locked) {
      const userId = this.getUserIdFromThreadName(thread.name);
      if (userId) {
        this.activeThreads.set(userId, thread.id);
      }
    }
  }

  removeThread(thread) {
    const userId = this.getUserIdFromThreadName(thread.name);
    if (userId) {
      this.activeThreads.delete(userId);
    }
  }

  handleThreadUpdate(thread) {
    const userId = this.getUserIdFromThreadName(thread.name);
    if (!userId) return;

    // Always check current thread state
    if (thread.archived || thread.locked) {
      this.activeThreads.delete(userId);
      Logger.info(`Thread ${thread.id} for user ${userId} is no longer active`);
    } else {
      this.activeThreads.set(userId, thread.id);
      Logger.info(`Thread ${thread.id} for user ${userId} is now active`);
    }
  }
}

// Guild Member mapper
class GuildMemberMapper {
  constructor() {
    this.members = new Map();
  }

  determineClassCategory(memberRoles, username, memberId) {
    let foundCategories = [];

    for (const [category, data] of Object.entries(CLASS_CATEGORIES)) {
      if (data.roleIds.some((id) => memberRoles.includes(id))) {
        foundCategories.push(data.id);
      }
    }

    if (foundCategories.length > 1) {
      Logger.warn(
        `User ${username} (${memberId}) has multiple class categories: ${foundCategories.join(
          ", "
        )}`
      );
    }

    return foundCategories[0] || null;
  }

  findGuildRole(member) {
    return (
      Object.values(GUILD_ROLES).find((role) => member.roles.cache.has(role.id))
        ?.name || null
    );
  }

  getWeaponRoles(memberRoles, username, memberId, member) {
    const weaponRoles = memberRoles.filter((roleId) =>
      Object.values(CLASS_CATEGORIES).some((category) =>
        category.roleIds.includes(roleId)
      )
    );

    if (weaponRoles.length > 1) {
      Logger.warn(
        `User ${username} (${memberId}) has multiple weapon roles: ${weaponRoles.join(
          ", "
        )}`
      );
    }

    const weaponRoleId = weaponRoles[0] || null;
    return {
      weaponRoleId,
      weaponRoleName: weaponRoleId
        ? member.roles.cache.get(weaponRoleId).name
        : null,
    };
  }

  getMember(memberId) {
    return this.members.get(memberId);
  }

  getAllMembers() {
    return Array.from(this.members.values());
  }

  async processMember(member) {
    try {
      const guildRole = this.findGuildRole(member);
      if (!guildRole) {
        // Clean up system roles if they have any
        const hasSystemRoles = Object.values(SYSTEM_ROLES).some((roleId) =>
          member.roles.cache.has(roleId)
        );
        if (hasSystemRoles) {
          await member.roles
            .remove(Object.values(SYSTEM_ROLES))
            .catch(() => {});
        }

        // Clean up tracking if they were tracked
        if (this.members.has(member.id)) {
          this.members.delete(member.id);
        }
        return;
      }

      const memberHasActiveThread = await hasActiveThread(member);
      const ingameName = await getIngameName(member.id);

      const {
        id: memberId,
        user: { username },
      } = member;
      const memberRoles = Array.from(member.roles.cache.keys());

      const classCategory = this.determineClassCategory(
        memberRoles,
        username,
        memberId
      );
      const { weaponRoleId, weaponRoleName } = this.getWeaponRoles(
        memberRoles,
        username,
        memberId,
        member
      );

      // Update system roles
      await updateSystemRoles(member, {
        hasClassRole: !!classCategory,
        hasIngameName: !!ingameName,
        hasThread: memberHasActiveThread,
      });

      this.members.set(memberId, {
        discordId: memberId,
        username,
        ingameName: ingameName,
        guild: guildRole,
        classCategory,
        weaponRole: weaponRoleId,
        weaponRoleName,
        hasActiveThread: memberHasActiveThread,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      Logger.error(`Error processing member ${member.id}: ${error.message}`);
    }
  }
}

async function sendIngameNameRequest(member) {
  const ingameName = await getIngameName(member.id);

  const button = new ButtonBuilder()
    .setCustomId("setIngameName")
    .setLabel(ingameName ? "Update In-Game Name" : "Set In-Game Name")
    .setStyle(ingameName ? ButtonStyle.Success : ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);

  const content = ingameName
    ? `Your current in-game name is set to: ${ingameName}\nClick below to update it if needed:`
    : "Please set your in-game name for Hazardous guild records:\n\n*Please ensure the name matches your in-game character name exactly*";

  try {
    await member.send({
      content,
      components: [row],
    });
  } catch (error) {
    Logger.error(`Cannot DM user ${member.id}: ${error.message}`);
  }
}

async function testDmIngameName() {
  const testUserId = "107391298171891712";
  const guild = await client.guilds.fetch(MAIN_SERVER_ID);
  const member = await guild.members.fetch(testUserId);

  if (member) {
    Logger.info(`Testing DM to ${member.user.tag}`);
    await sendIngameNameRequest(member);
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
const threadManager = new ThreadManager();

// Event handlers
client.once("ready", async () => {
  Logger.info(`Bot logged in as ${client.user.tag}`);
  await initializeDb();
  const mainGuild = await client.guilds.fetch(MAIN_SERVER_ID);
  await threadManager.initializeCache(mainGuild);

  const channel = await mainGuild.channels.fetch(INGAME_NAME_CHANNEL);
  if (channel) {
    await createIngameNameMessage(channel);
  }

  await syncMembers();
  //startIngameNameReminders();
  //await testDmIngameName();
  await client.application.commands.set(commands);
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
      debouncedSync();
    }
  }
});

client.on("threadCreate", async (thread) => {
  if (thread.guild.id === MAIN_SERVER_ID) {
    threadManager.addThread(thread);
    await updateMemberFromThread(thread);
  }
});

client.on("threadDelete", async (thread) => {
  if (thread.guild.id === MAIN_SERVER_ID) {
    threadManager.removeThread(thread);
    await updateMemberFromThread(thread);
  }
});

client.on("threadUpdate", async (oldThread, newThread) => {
  if (newThread.guild.id === MAIN_SERVER_ID) {
    threadManager.handleThreadUpdate(newThread);
    await updateMemberFromThread(newThread);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton() && interaction.customId === "setIngameName") {
    const guild = await client.guilds.fetch(MAIN_SERVER_ID);
    const member = await guild.members.fetch(interaction.user.id);
    const hasGuildRole = Object.values(GUILD_ROLES).some((role) =>
      member.roles.cache.has(role.id)
    );

    if (!hasGuildRole) {
      await interaction.reply({
        content: "You must be in one of our guilds to set your in-game name.",
        ephemeral: true,
      });
      return;
    }

    const existingName = await getIngameName(interaction.user.id);
    await interaction.showModal(createIngameNameModal(existingName || ""));
  }

  if (
    interaction.isModalSubmit() &&
    interaction.customId === "ingameNameModal"
  ) {
    try {
      const name = interaction.fields
        .getTextInputValue("ingameNameInput")
        .trim();

      if (!name || name.length < 2 || name.length > 15) {
        await interaction.reply({
          content: "Your in-game name must be between 2 and 15 characters.",
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: `Your in-game name has been set to: ${name}`,
        ephemeral: true,
      });

      await saveIngameName(interaction.user.id, name);
      const guild = await client.guilds.fetch(MAIN_SERVER_ID);
      const member = await guild.members.fetch(interaction.user.id);
      await memberMapper.processMember(member);
      await debouncedSync();

      // Only update DM message
      if (interaction.message?.channel?.type === 1) {
        // 1 = DM
        const newButton = new ButtonBuilder()
          .setCustomId("setIngameName")
          .setLabel("Update In-Game Name")
          .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(newButton);
        await interaction.message.edit({
          content: `Your current in-game name is set to: ${name}\nClick below to update it if needed:`,
          components: [row],
        });
      }
    } catch (error) {
      Logger.error(`Modal submit error: ${error.message}`);
      await interaction.reply({
        content:
          "There was an error processing your request. Please try again.",
        ephemeral: true,
      });
    }
  }

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
        const newName = interaction.options.getString("name").trim();

        // Validate name
        if (!newName || newName.length < 2 || newName.length > 15) {
          await interaction.reply({
            content: "The in-game name must be between 2 and 15 characters.",
            ephemeral: true,
          });
          return;
        }

        try {
          const guild = await client.guilds.fetch(MAIN_SERVER_ID);
          const member = await guild.members.fetch(targetUser.id);

          // Check if target has guild role
          const hasGuildRole = Object.values(GUILD_ROLES).some((role) =>
            member.roles.cache.has(role.id)
          );

          if (!hasGuildRole) {
            await interaction.reply({
              content: "The target user must be in one of our guilds.",
              ephemeral: true,
            });
            return;
          }

          // Save and update
          await saveIngameName(targetUser.id, newName);
          await memberMapper.processMember(member);
          await debouncedSync();

          await interaction.reply({
            content: `Set ${targetUser}'s in-game name to: ${newName}`,
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
        const hasGuildRole = Object.values(GUILD_ROLES).some((role) =>
          interaction.member.roles.cache.has(role.id)
        );

        if (!hasGuildRole) {
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

const debouncedSync = debounce(async () => {
  try {
    await syncMembersToSheet(memberMapper.members);
  } catch (error) {
    Logger.error(`Failed to sync members to sheet: ${error.message}`);
  }
}, 5000);

setInterval(() => {
  debouncedSync();
}, 5 * 60 * 1000);

async function startIngameNameReminders() {
  // Wait for 3 days before sending the first reminder
  setTimeout(async () => {
    const mainGuild = await client.guilds.fetch(MAIN_SERVER_ID);
    const members = await mainGuild.members.fetch();

    for (const [id, member] of members) {
      // Skip bots first (fastest check)
      if (member.user.bot) continue;

      // Check guild role next (memory check)
      const guildRole = memberMapper.findGuildRole(member);
      if (!guildRole) continue;

      // Check database last (slowest check)
      const hasName = await getIngameName(id);
      if (!hasName) {
        await sendIngameNameRequest(member);
      }
    }

    // Set interval to send reminders every 3 days
    setInterval(async () => {
      const mainGuild = await client.guilds.fetch(MAIN_SERVER_ID);
      const members = await mainGuild.members.fetch();

      for (const [id, member] of members) {
        // Skip bots first (fastest check)
        if (member.user.bot) continue;

        // Check guild role next (memory check)
        const guildRole = memberMapper.findGuildRole(member);
        if (!guildRole) continue;

        // Check database last (slowest check)
        const hasName = await getIngameName(id);
        if (!hasName) {
          await sendIngameNameRequest(member);
        }
      }
    }, 3 * 24 * 60 * 60 * 1000); // 3 days
  }, 3 * 24 * 60 * 60 * 1000); // Initial 3 days wait
}

client.login(process.env.TOKEN);
