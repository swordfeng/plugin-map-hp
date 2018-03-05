import * as fs from 'fs';
import { ev } from './index.es';
import { remote } from 'electron';
import { URL } from 'url';
import * as request from 'superagent';
import * as path from 'path';

const CLIENT_ID = '1d300286-97ec-48b1-9a9a-b03433562dc3';
const CLIENT_SECRET = 'vrasgYITFP557![azMZ42~[';

export class OneDriveClient {
    constructor(credentialFile) {
        this.credentialFile = credentialFile;
        this.authorized = false;
        this.session = null;
        if (fs.existsSync(credentialFile)) {
            try {
                let config = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
                this.accessToken = config.accessToken;
                this.refreshToken = config.refreshToken;
                this.expires = new Date(config.expires);
                this.authorized = true;
            }
            catch (err) {
            }
        }
    }
    async auth() {
        let code = await new Promise((resolve, reject) => {
            let state = Math.random() * 1000000 | 0;
            let window = new remote.BrowserWindow({
                parent: remote.getCurrentWindow(),
                width: 800,
                height: 600,
                title: 'Onedrive Auth',
                nodeIntegration: false,
                webSecurity: false,
            });
            function authCallback(req) {
                try {
                    if (req.url.pathname !== '/onedrive_auth'
                        || parseInt(req.url.searchParams.get('state')) !== state) return;
                    window.removeAllListeners('closed');
                    window.close();
                    let code = req.url.searchParams.get('code');
                    ev.removeListener('httpRequest', authCallback);
                    resolve(code);
                } catch (err) {
                    reject(err);
                }
            }

            ev.on('httpRequest', authCallback);
            window.webContents.on('did-navigate', (e, url) => authCallback({url: new URL(url)}));
            
            let u = new URL('/consumers/oauth2/v2.0/authorize', 'https://login.microsoftonline.com/');
            u.searchParams.append('client_id', CLIENT_ID);
            u.searchParams.append('response_type', 'code');
            u.searchParams.append('redirect_uri', 'http://localhost:9080/onedrive_auth');
            u.searchParams.append('response_mode', 'query');
            u.searchParams.append('scope', 'offline_access user.read files.readwrite');
            u.searchParams.append('state', state);
            window.loadURL(u.toString());
            window.setMenu(null);
            window.show();
            window.on('closed', () => {
                ev.removeListener('httpRequest', authCallback);
                reject(new Error('auth window closed'));
                window = null;
            });
        });
        await this.save((await request
                .post('https://login.microsoftonline.com/consumers/oauth2/v2.0/token')
                .type('form')
                .send({
                    client_id: CLIENT_ID,
                    scope: 'user.read files.readwrite',
                    code,
                    redirect_uri: 'http://localhost:9080/onedrive_auth',
                    grant_type: 'authorization_code',
                    client_secret: CLIENT_SECRET
                })).body);
        await this.init();
    }
    async refresh() {
        await this.save((await request
            .post('https://login.microsoftonline.com/consumers/oauth2/v2.0/token')
            .type('form')
            .send({
                client_id: CLIENT_ID,
                scope: 'user.read files.readwrite',
                refresh_token: this.refreshToken,
                redirect_uri: 'http://localhost:9080/onedrive_auth',
                grant_type: 'refresh_token',
                client_secret: CLIENT_SECRET
            })).body);
    }
    async save(data) {
        let config = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expires: Date.now() + data.expires_in * 1000 - 30000
        };
        fs.writeFileSync(this.credentialFile, JSON.stringify(config));
        this.accessToken = config.accessToken;
        this.refreshToken = config.refreshToken;
        this.expires = new Date(config.expires);
        this.authorized = true;
    }
    async getAccessToken() {
        if (new Date() > this.expires) {
            await this.refresh();
        }
        return this.accessToken;
    }
    async init() {
        if (!this.authorized) return;
        let token = await this.getAccessToken();
        try {
            let response = await request
                .get('https://graph.microsoft.com/v1.0/me/drive')
                .set('Authorization', 'Bearer ' + token);
            this.authorized = true;
            await this.sessionInit();
        } catch (err) {
            console.log(err);
            this.authorized = false;
            return;
        }
    }

    async sessionInit() {
        this.session = {
            id: Date.now().toString()
        };
        let root = await this.list('/');
        let names = root.map(item => item.name);
        if (!names.includes('data')) await this.createFolder('data');
        if (!names.includes('events')) await this.createFolder('events');
        await this.createFolder('events/' + this.session.id);
    }

    async list(filepath) {
        let token = await this.getAccessToken();
        console.log(token);
        let url = filepath === '/'
            ? 'https://graph.microsoft.com/v1.0/me/drive/special/approot/children'
            : `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURI(filepath)}:/children`
        let response = await request
            .get(url)
            .set('Authorization', 'Bearer ' + token);
        return response.body.value;
    }
    async createFolder(filepath) {
        let token = await this.getAccessToken();
        let { dir, name } = path.parse(filepath);
        let url;
        if (dir === '' || dir === '/') {
            url = 'https://graph.microsoft.com/v1.0/me/drive/special/approot/children';
        } else {
            url = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURI(filepath)}:/children`;
        }
        let response = await request
            .post(url)
            .set('Authorization', 'Bearer ' + token)
            .send({
                name,
                folder: {},
                '@microsoft.graph.conflictBehavior': 'fail'
              });
        console.log(response);
    }
    async upload(filepath, data) {
        if (data === null) {
            let response = await request
                .delete(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURI(filepath)}:/content`)
                .set('Authorization', 'Bearer ' + await this.getAccessToken());
        } else {
            let response = await request
                .put(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURI(filepath)}:/content`)
                .set('Authorization', 'Bearer ' + await this.getAccessToken())
                .type('text/plain')
                .send(data);
        }
    }
    async download(filepath) {
        try {
            let response = await request
                .get(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURI(filepath)}:/content`)
                .set('Authorization', 'Bearer ' + await this.getAccessToken());
        } catch (err) {
            if (err.status === 404) return null;
            throw err;
        }
    }

    async get(key) {
        return await this.download(path.join(['data', encodeURIComponent(key)]));
    }
    async put(key, value) {
        await this.upload(path.join(['data', encodeURIComponent(key)]), value);
    }

    async publish(type, data) {}
    async retrieve(type, since) {}
}

