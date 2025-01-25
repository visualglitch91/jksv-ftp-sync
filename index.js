const ftp = require("basic-ftp");
const fs = require("fs-extra");
const path = require("path");

// Configuration array
const config = require("./config.json");

// Track server states to sync only when transitioning from offline to online
const serverStates = {};

async function ensureLocalDirectory(localPath) {
  await fs.ensureDir(localPath);
}

async function listFTPFiles(client, remotePath) {
  try {
    const files = await client.list(remotePath);
    return files;
  } catch (error) {
    console.error(`Error listing FTP files at ${remotePath}:`, error);
    return [];
  }
}

async function downloadFiles(client, remotePath, localPath) {
  const items = await listFTPFiles(client, remotePath);

  for (const item of items) {
    const localItemPath = path.join(localPath, item.name);
    const remoteItemPath = path.join(remotePath, item.name);

    if (item.isDirectory) {
      await ensureLocalDirectory(localItemPath);
      await downloadFiles(client, remoteItemPath, localItemPath);
    } else {
      if (!(await fs.pathExists(localItemPath))) {
        await client.downloadTo(localItemPath, remoteItemPath);
      }
    }
  }
}

async function uploadFiles(client, localPath, remotePath) {
  const items = await fs.readdir(localPath);

  for (const item of items) {
    const localItemPath = path.join(localPath, item);
    const remoteItemPath = path.join(remotePath, item);
    const stats = await fs.stat(localItemPath);

    if (stats.isDirectory()) {
      try {
        await client.ensureDir(remoteItemPath);
      } catch (error) {
        console.error(
          `Error ensuring remote directory: ${remoteItemPath}`,
          error
        );
      }
      await uploadFiles(client, localItemPath, remoteItemPath);
    } else {
      try {
        const existsRemotely = await client
          .size(remoteItemPath)
          .catch(() => null);

        if (!existsRemotely) {
          await client.uploadFrom(localItemPath, remoteItemPath);
        }
      } catch (error) {
        console.error(`Error uploading file: ${remoteItemPath}`, error);
      }
    }
  }
}

// Load previous file state
async function loadFileState() {
  try {
    return await fs.readJson(config.db);
  } catch {
    return {};
  }
}

// Save file state
async function saveFileState(fileState) {
  await fs.writeJson(config.db, fileState, { spaces: 2 });
}

// Get a list of all files and directories in a local directory
async function listLocalFiles(dirPath = config.local) {
  let results = {};

  const items = await fs.readdir(dirPath);
  for (const item of items) {
    const itemPath = path.join(dirPath, item);
    const stats = await fs.stat(itemPath);

    if (stats.isDirectory()) {
      results[item] = await listLocalFiles(itemPath);
    } else {
      results[item] = "file";
    }
  }

  return results;
}

// Compare previous state to current state, mark deleted files in state
function markDeletedFiles(previousState, currentState) {
  let newState = { ...previousState };

  for (const key in previousState) {
    if (!(key in currentState)) {
      newState[key] = "deleted";
    } else if (
      typeof previousState[key] === "object" &&
      typeof currentState[key] === "object"
    ) {
      newState[key] = markDeletedFiles(previousState[key], currentState[key]);
    }
  }

  for (const key in currentState) {
    if (newState[key] !== "deleted") {
      if (typeof currentState[key] === "object") {
        newState[key] = markDeletedFiles(
          previousState?.[key] || {},
          currentState[key]
        );
      } else {
        newState[key] = "file";
      }
    }
  }

  return newState;
}

// Get deleted files from the file state
function getDeletedFiles(fileState, basePath = "") {
  let deletedFiles = [];

  for (const key in fileState) {
    const fullPath = path.join(basePath, key);
    if (fileState[key] === "deleted") {
      deletedFiles.push(fullPath);
    } else if (typeof fileState[key] === "object") {
      deletedFiles = deletedFiles.concat(
        getDeletedFiles(fileState[key], fullPath)
      );
    }
  }

  return deletedFiles;
}

// Delete files and directories from FTP servers
async function deleteFilesFromServers(client, remotePath, deletedFiles) {
  for (const file of deletedFiles) {
    const remoteFilePath = path.join(remotePath, file).replace(/\\/g, "/");

    try {
      // List the parent directory contents
      const parentDir = path.dirname(remoteFilePath);
      const fileInfo = await client.list(parentDir);
      const targetItem = fileInfo.find(
        (item) => item.name === path.basename(remoteFilePath)
      );

      if (!targetItem) {
        console.log(
          `[INFO] File or directory not found on server: ${remoteFilePath}`
        );
        continue; // Skip to the next file
      }

      if (targetItem.isDirectory) {
        await client.removeDir(remoteFilePath); // Delete directory recursively
        console.log(`[INFO] Deleted remote directory: ${remoteFilePath}`);
      } else {
        await client.remove(remoteFilePath); // Delete single file
        console.log(`[INFO] Deleted remote file: ${remoteFilePath}`);
      }
    } catch (error) {
      console.error(`[ERROR] Failed to delete: ${remoteFilePath}`, error);
    }
  }
}

async function monitorAndSync() {
  console.log(`[INFO] Monitoring servers...`);
  const servers = [];
  const previousFileState = await loadFileState();

  // Connection step
  for (const { address, folder } of config.servers) {
    let online = false;
    const [host, port] = address.split(":");
    const ftpClient = new ftp.Client();

    try {
      await ftpClient.access({
        host,
        port: parseInt(port, 10),
        user: "anonymous",
        password: "anonymous",
        secure: false,
      });

      online = true;
      console.log(`[INFO] Server online: ${address}`);
    } catch (err) {
      console.log(`[WARN] Server offline: ${address}`);
    }

    servers.push({ address, folder, online, ftp: ftpClient });
  }

  const shouldSync = servers.some((server) => {
    const previousState = serverStates[server.address];
    return !previousState && server.online;
  });

  if (shouldSync) {
    console.log(`[INFO] New server online, syncing...`);

    await ensureLocalDirectory(config.local);

    // Detect deleted files
    const currentFileState = await listLocalFiles();

    const updatedFileState = markDeletedFiles(
      previousFileState,
      currentFileState
    );

    const deletedFiles = getDeletedFiles(updatedFileState);
    console.log(`[INFO] Deleted files detected:`, deletedFiles);

    // Deleting files from FTP servers
    for (const server of servers) {
      if (server.online) {
        console.log(`[INFO] Deleting files on server: ${server.address}`);

        const remotePath = `/${server.folder}`;
        await deleteFilesFromServers(server.ftp, remotePath, deletedFiles);
      }
    }

    // Downloading step
    for (const server of servers) {
      if (server.online) {
        console.log(`[INFO] Downloading from server: ${server.address}`);

        const remotePath = `/${server.folder}`;
        await downloadFiles(server.ftp, remotePath, config.local);
      }
    }

    // Uploading step
    for (const server of servers) {
      if (server.online) {
        console.log(`[INFO] Uploading to server: ${server.address}`);

        const remotePath = `/${server.folder}`;
        await uploadFiles(server.ftp, config.local, remotePath);
      }
    }

    // Save updated file state
    await saveFileState(
      markDeletedFiles(updatedFileState, await listLocalFiles())
    );

    console.log(`[INFO] Synchronization completed.`);
  } else {
    console.log(`[INFO] No servers transitioned from offline to online.`);
  }

  // Close client
  for (const server of servers) {
    serverStates[server.address] = server.online;
    server.ftp.close();
  }

  // Retry after a delay if the server is offline
  setTimeout(monitorAndSync, config.interval);
}

monitorAndSync();
