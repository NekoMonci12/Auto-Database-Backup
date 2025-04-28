const { exec } = require('child_process');
const { promisify } = require('util');
const schedule = require('node-schedule');
const axios = require('axios');
const fs = require('fs');
const Client = require('ssh2-sftp-client');
const ftp = require('basic-ftp');
const AWS = require('aws-sdk');
require('dotenv').config();

const execAsync = promisify(exec);

// Database settings
typeof process.env.DATABASES === 'string' || (process.env.DATABASES = 'paymenter,ctrlpanel,pterodactyl');
const databases = process.env.DATABASES.split(',');

// Backup methods & paths
const UPLOAD_METHOD = process.env.UPLOAD_METHOD || 'local'; // local, sftp, ftp, s3
const LOCAL_PATH = process.env.LOCAL_PATH || 'backup/';

// SFTP config
const SFTP_CONFIG = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT || '22',
  username: process.env.SFTP_USER,
  password: process.env.SFTP_PASSWORD,
  remotePath: process.env.SFTP_REMOTE_PATH || '/'
};

// FTP config
const FTP_CONFIG = {
  host: process.env.FTP_HOST,
  user: process.env.FTP_USER,
  password: process.env.FTP_PASSWORD
};

// AWS S3 config
const S3_BUCKET = process.env.S3_BUCKET;
const S3_ENDPOINT = process.env.S3_ENDPOINT || null;
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE === 'true';

const s3Options = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
};
if (S3_ENDPOINT) {
  s3Options.endpoint = S3_ENDPOINT;
  s3Options.s3ForcePathStyle = S3_FORCE_PATH_STYLE;
}
const s3 = new AWS.S3(s3Options);

// Discord webhook
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Helpers
const getCurrentDateTime = () => {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return { date, time };
};

const sendDiscordWebhook = (message) => {
  if (!DISCORD_WEBHOOK_URL) return;
  const embed = {
    embeds: [{ description: message, color: 0x00ff00, timestamp: new Date().toISOString() }]
  };
  axios.post(DISCORD_WEBHOOK_URL, embed)
       .then(() => console.log('Webhook sent'))
       .catch(err => console.error('Webhook error:', err.message));
};

// Backup & upload
const backupDatabase = async (db) => {
  const { date, time } = getCurrentDateTime();
  const fileName = `${db}-${date}-${time}.sql`;
  const tempFile = `/tmp/${fileName}`;
  const localFile = `${LOCAL_PATH}${fileName}`;
  try {
    const { stderr } = await execAsync(
      `mysqldump -u ${process.env.DB_USER} -p'${process.env.DB_PASSWORD}' --opt ${db} > ${tempFile}`
    );
    if (stderr && !stderr.includes('Deprecated program name')) throw new Error(stderr);
    if (/local/.test(UPLOAD_METHOD)) {
        fs.renameSync(tempFile, localFile);
        sendDiscordWebhook(`✅ Backup saved locally: ${fileName}`);
    }
    if (/sftp|ftp|s3/.test(UPLOAD_METHOD)) await uploadExternal(localFile, fileName, date);
  } catch (err) {
    sendDiscordWebhook(`❌ Error backing up ${db}: ${err.message}`);
  }
};

const uploadExternal = async (path, fileName, date) => {
  if (/sftp/.test(UPLOAD_METHOD)) {
    const sftp = new Client();
    await sftp.connect(SFTP_CONFIG);
    await sftp.put(path, `${SFTP_CONFIG.remotePath}/${fileName}`);
    await sftp.end();
    sendDiscordWebhook(`📤 Uploaded via SFTP: ${fileName}`);
  }
  if (/ftp/.test(UPLOAD_METHOD)) {
    const client = new ftp.Client();
    await client.access(FTP_CONFIG);
    await client.uploadFrom(path, fileName);
    client.close();
    sendDiscordWebhook(`📤 Uploaded via FTP: ${fileName}`);
  }
  if (/s3/.test(UPLOAD_METHOD) && S3_BUCKET) {
    // Path-style with custom endpoint: URL -> S3_ENDPOINT/S3_BUCKET/fileName
    const key = `${fileName}`;
    await s3.upload({ Bucket: S3_BUCKET, Key: key, Body: fs.createReadStream(path) }).promise();
    const publicUrl = S3_ENDPOINT
      ? `${S3_ENDPOINT.replace(/\/+$/,'')}/${S3_BUCKET}/${key}`
      : `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    sendDiscordWebhook(`📤 Uploaded to S3: ${publicUrl}`);
  }
};

const backupAll = async () => { for (const db of databases) await backupDatabase(db); };

// Schedule every 3 hours + immediate run
schedule.scheduleJob('0 */3 * * *', backupAll);
backupAll();
