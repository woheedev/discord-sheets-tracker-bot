import { Query } from "node-appwrite";
import { Logger } from "./logger.js";

async function getUserDocument(databases, userId) {
  try {
    const result = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_COLLECTION_ID,
      [Query.equal("discord_id", userId)]
    );
    return result.documents[0] || null;
  } catch (error) {
    Logger.error(`Failed to get user document for ${userId}: ${error.message}`);
    return null;
  }
}

export async function getAllUserData(databases, userIds) {
  try {
    // Get all documents in one query
    const result = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_COLLECTION_ID,
      [Query.equal("discord_id", userIds)],
      100 // Adjust limit if needed
    );

    // Convert to a map for easy lookup
    const userDataMap = new Map();

    result.documents.forEach((doc) => {
      const primary = doc.primary_weapon;
      const secondary = doc.secondary_weapon;
      let weaponNames = null;

      if (primary || secondary) {
        if (!primary) weaponNames = secondary;
        else if (!secondary) weaponNames = primary;
        else weaponNames = `${primary}/${secondary}`;
      }

      userDataMap.set(doc.discord_id, {
        ingameName: doc.ingame_name || null,
        guild: doc.guild || null,
        class: doc.class || null,
        weaponNames,
        hasThread: doc.has_thread || false,
        $createdAt: doc.$createdAt,
        $updatedAt: doc.$updatedAt,
      });
    });

    return userDataMap;
  } catch (error) {
    Logger.error(`Failed to get user data batch: ${error.message}`);
    return new Map();
  }
}

// Keep single user query for individual operations
export async function getUserData(databases, userId) {
  const doc = await getUserDocument(databases, userId);
  if (!doc) return null;

  const primary = doc.primary_weapon;
  const secondary = doc.secondary_weapon;
  let weaponNames = null;

  if (primary || secondary) {
    if (!primary) weaponNames = secondary;
    else if (!secondary) weaponNames = primary;
    else weaponNames = `${primary}/${secondary}`;
  }

  return {
    ingameName: doc.ingame_name || null,
    guild: doc.guild || null,
    class: doc.class || null,
    weaponNames,
    hasThread: doc.has_thread || false,
    $createdAt: doc.$createdAt,
    $updatedAt: doc.$updatedAt,
  };
}

export async function setIngameName(databases, userId, ingameName) {
  try {
    const validation = validateIngameName(ingameName);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const doc = await getUserDocument(databases, userId);

    if (doc) {
      // Update existing document
      await databases.updateDocument(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_COLLECTION_ID,
        doc.$id,
        {
          ingame_name: validation.value,
        }
      );
    } else {
      // Create new document
      await databases.createDocument(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_COLLECTION_ID,
        "unique()",
        {
          discord_id: userId,
          ingame_name: validation.value,
        }
      );
    }
    return true;
  } catch (error) {
    Logger.error(
      `Failed to set ingame name for user ${userId}: ${error.message}`
    );
    throw error;
  }
}

export function validateIngameName(name) {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "Invalid input type" };
  }

  const trimmedName = name.trim();

  if (trimmedName.length < 2) {
    return { valid: false, error: "Name must be at least 2 characters long" };
  }

  if (trimmedName.length > 16) {
    return { valid: false, error: "Name cannot be longer than 16 characters" };
  }

  // Check for valid characters (letters, numbers, spaces, and common special characters)
  const validCharRegex = /^[a-zA-Z0-9\s._-]+$/;
  if (!validCharRegex.test(trimmedName)) {
    return {
      valid: false,
      error:
        "Name can only contain letters, numbers, spaces, dots, underscores, and hyphens",
    };
  }

  return { valid: true, value: trimmedName };
}
