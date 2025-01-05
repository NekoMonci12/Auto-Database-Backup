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
const databases = ['paymenter','ctrlpanel','pterodactyl'];

const UPLOAD_METHOD = process.env.UPLOAD_METHOD || 'sftp';
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
    const backupFile = `/tmp/${databaseName}-${date}-${time}.sql`;

    try {
        const { stderr } = await execAsync(`mysqldump -u ${DB_USER} -p'${DB_PASSWORD}' --opt ${databaseName} > ${backupFile}`);
        if (stderr && !stderr.includes('Deprecated program name')) {
            throw new Error(stderr);
        }
        console.log(`${databaseName} backup completed: ${backupFile}`);
        sendDiscordWebhook(`${databaseName} backup completed: ${backupFile}`);
        await uploadFile(backupFile, databaseName, date, time);
    } catch (error) {
        console.error(`Error executing ${databaseName} backup: ${error.message}`);
        sendDiscordWebhook(`Error executing ${databaseName} backup: ${error.message}`);
    }
};

const uploadFile = async (filePath, databaseName, date, time) => {
    const remoteFileName = `${databaseName}-${date}-${time}.sql`;

    try {
        switch (UPLOAD_METHOD) {
            case 'sftp':
                const sftp = new Client();
                await sftp.connect(SFTP_CONFIG);
                await sftp.put(filePath, `${SFTP_CONFIG.remotePath}/${remoteFileName}`);
                await sftp.end();
                break;
            case 'ftp':
                const ftpClient = new ftp.Client();
                await ftpClient.access(FTP_CONFIG);
                await ftpClient.uploadFrom(filePath, remoteFileName);
                ftpClient.close();
                break;
            case 'local':
                fs.renameSync(filePath, `${LOCAL_PATH}${remoteFileName}`);
                break;
            default:
                throw new Error(`Unsupported upload method: ${UPLOAD_METHOD}`);
        }
    } catch (error) {
        console.error(`Error uploading file: ${error.message}`);
    }
};

const backupDatabases = async () => {
    for (const db of databases) {
        await backupDatabase(db);
    }
};

const sendDiscordWebhook = (message) => {
    const embed = {
        embeds: [{
            description: message,
            color: 0x00ff00,
            timestamp: new Date().toISOString()
        }]
    };

    axios.post(DISCORD_WEBHOOK_URL, embed)
        .then(response => {
            console.log('Discord webhook sent:', response.data);
        })
        .catch(error => {
            console.error('Error sending Discord webhook:', error.message);
        });
};

// Schedule backup every 3 hours
schedule.scheduleJob('0 */3 * * *', backupDatabases);

backupDatabases();
