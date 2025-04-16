const { exec } = require('child_process');
const { promisify } = require('util');
const schedule = require('node-schedule');
const axios = require('axios');
const fs = require('fs');
const Client = require('ssh2-sftp-client');
const ftp = require('basic-ftp');
require('dotenv').config();

const execAsync = promisify(exec);

const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const databases = ['paymenter', 'ctrlpanel', 'pterodactyl'];

const UPLOAD_METHOD = process.env.UPLOAD_METHOD || 'local';
const LOCAL_PATH = process.env.LOCAL_PATH || '/backup/';

const SFTP_CONFIG = {
    host: process.env.SFTP_HOST,
    port: process.env.SFTP_PORT || '22',
    username: process.env.SFTP_USER,
    password: process.env.SFTP_PASSWORD,
    remotePath: process.env.SFTP_REMOTE_PATH || '/'
};

const FTP_CONFIG = {
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD
};

const getCurrentDateTime = () => {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    return { date, time };
};

const backupDatabase = async (databaseName) => {
    const { date, time } = getCurrentDateTime();
    const tempFile = `/tmp/${databaseName}-${date}-${time}.sql`;
    const localFilePath = `${LOCAL_PATH}${databaseName}-${date}-${time}.sql`;

    try {
        const { stderr } = await execAsync(`mysqldump -u ${DB_USER} -p'${DB_PASSWORD}' --opt ${databaseName} > ${tempFile}`);
        if (stderr && !stderr.includes('Deprecated program name')) {
            throw new Error(stderr);
        }

        // Move to local
        fs.renameSync(tempFile, localFilePath);
        console.log(`${databaseName} backup saved locally: ${localFilePath}`);
        sendDiscordWebhook(`${databaseName} backup saved locally: ${localFilePath}`);

        // Upload externally if configured
        if (UPLOAD_METHOD === 'sftp' || UPLOAD_METHOD === 'ftp' || UPLOAD_METHOD === 'both') {
            await uploadExternal(localFilePath, databaseName, date, time);
        }
    } catch (error) {
        console.error(`Error backing up ${databaseName}: ${error.message}`);
        sendDiscordWebhook(`❌ Error backing up ${databaseName}: ${error.message}`);
    }
};

const uploadExternal = async (filePath, databaseName, date, time) => {
    const remoteFileName = `${databaseName}-${date}-${time}.sql`;

    try {
        if (UPLOAD_METHOD === 'sftp' || UPLOAD_METHOD === 'both') {
            const sftp = new Client();
            await sftp.connect(SFTP_CONFIG);
            await sftp.put(filePath, `${SFTP_CONFIG.remotePath}/${remoteFileName}`);
            await sftp.end();
            console.log(`Uploaded to SFTP: ${remoteFileName}`);
            sendDiscordWebhook(`📤 Uploaded ${databaseName} to SFTP`);
        }

        if (UPLOAD_METHOD === 'ftp' || UPLOAD_METHOD === 'both') {
            const ftpClient = new ftp.Client();
            await ftpClient.access(FTP_CONFIG);
            await ftpClient.uploadFrom(filePath, remoteFileName);
            ftpClient.close();
            console.log(`Uploaded to FTP: ${remoteFileName}`);
            sendDiscordWebhook(`📤 Uploaded ${databaseName} to FTP`);
        }
    } catch (error) {
        console.error(`Error uploading ${databaseName}: ${error.message}`);
        sendDiscordWebhook(`❌ Error uploading ${databaseName}: ${error.message}`);
    }
};

const backupDatabases = async () => {
    for (const db of databases) {
        await backupDatabase(db);
    }
};

const sendDiscordWebhook = (message) => {
    if (!DISCORD_WEBHOOK_URL) return;

    const embed = {
        embeds: [{
            description: message,
            color: 0x00ff00,
            timestamp: new Date().toISOString()
        }]
    };

    axios.post(DISCORD_WEBHOOK_URL, embed)
        .then(res => console.log('Webhook sent'))
        .catch(err => console.error('Webhook error:', err.message));
};

// Schedule backup every 3 hours
schedule.scheduleJob('0 */3 * * *', backupDatabases);

// Run immediately on script start
backupDatabases();
