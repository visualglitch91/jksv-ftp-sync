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

async function monitorAndSync() {
  console.log(`[INFO] Monitoring servers...`);

  const servers = [];

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

    // Downloading step
    for (const server of servers) {
      if (server.online) {
        console.log(`[INFO] Downloading from server: ${server.address}`);

        const remotePath = `/${server.folder}`;
        const localPath = path.join(config.local, server.folder);
        await ensureLocalDirectory(localPath);
        await downloadFiles(server.ftp, remotePath, localPath);
      }
    }

    // Uploading step
    for (const server of servers) {
      if (server.online) {
        console.log(`[INFO] Uploading to server: ${server.address}`);

        const remotePath = `/${server.folder}`;
        const localPath = path.join(config.local, server.folder);
        await uploadFiles(server.ftp, localPath, remotePath);
      }
    }

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
