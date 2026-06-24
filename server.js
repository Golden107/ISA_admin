require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const formRoutes = require('./routes/forms');
app.use('/api/forms', formRoutes);

const userRoutes = require('./routes/users');
app.use('/api/users', userRoutes);

const webhookRoutes = require('./routes/webhook');
app.use('/api/webhook', webhookRoutes.router);

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'login.html')); });
app.get('/dashboard', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'dashboard.html')); });
app.get('/apply', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'forms', 'apply.html')); });
app.get('/users', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'users.html')); });
app.get('/bind', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'bind.html')); });


app.get('/api/reset-data', async (req, res) => {
    try {
        await db.query('SET FOREIGN_KEY_CHECKS = 0');
        await db.query('TRUNCATE TABLE approval_logs');
        await db.query('TRUNCATE TABLE applications');
        await db.query('SET FOREIGN_KEY_CHECKS = 1');
        res.send('<h2>✅ 系統清理完成！</h2><a href="/dashboard">點此返回系統大廳</a>');
    } catch (error) { res.status(500).send('清除失敗'); }
});

// 💡 臨時除錯用：用來檢查伺服器上的真實路徑
app.get('/api/debug-path', (req, res) => {
    const fs = require('fs');
    const path = require('path');

    const uploadPath = path.join(__dirname, 'public/uploads');
    const isUploadDirExist = fs.existsSync(uploadPath);

    res.json({
        "1. 專案根目錄 (cwd)": process.cwd(),
        "2. 目前這支檔案的目錄 (__dirname)": __dirname,
        "3. 系統計算出的上傳資料夾路徑": uploadPath,
        "4. 上傳資料夾目前是否存在?": isUploadDirExist ? "✅ 存在" : "❌ 不存在"
    });
});


app.post('/api/bind-line', async (req, res) => {
    const { email, password, lineId } = req.body;
    try {
        const [users] = await db.query('SELECT id, name FROM users WHERE email = ? AND password_hash = ?', [email, password]);
        if (users.length > 0) {
            await db.query('UPDATE users SET line_user_id = ? WHERE id = ?', [lineId, users[0].id]);
            const { sendLineMessage } = require('./routes/webhook');
            await sendLineMessage(lineId, `✅ 綁定成功！歡迎您，${users[0].name}。`);
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '信箱或密碼錯誤' });
        }
    } catch (error) { res.status(500).json({ success: false, message: '系統連線異常' }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.query('SELECT id, name, email, role FROM users WHERE email = ? AND password_hash = ?', [email, password]);
        if (users.length > 0) res.json({ success: true, user: users[0], redirect: '/dashboard' });
        else res.status(401).json({ success: false, message: '帳號或密碼錯誤，請重新輸入' });
    } catch (error) { res.status(500).json({ success: false, message: '伺服器錯誤' }); }
});

// 💡 員工自行修改密碼的 API
app.post('/api/change-password', async (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    if (!userId || !oldPassword || !newPassword) return res.status(400).json({ success: false, message: '請完整輸入' });
    try {
        const [users] = await db.query('SELECT id FROM users WHERE id = ? AND password_hash = ?', [userId, oldPassword]);
        if (users.length === 0) return res.json({ success: false, message: '舊密碼錯誤' });
        await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newPassword, userId]);
        res.json({ success: true, message: '密碼變更成功！請重新登入。' });
    } catch (error) { res.status(500).json({ success: false, message: '伺服器錯誤' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(` 補教行政系統已啟動！ Port: ${PORT}`);
    console.log(`===========================================`);
});
