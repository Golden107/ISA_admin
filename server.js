require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API 路由掛載
const formRoutes = require('./routes/forms');
app.use('/api/forms', formRoutes);

const userRoutes = require('./routes/users');
app.use('/api/users', userRoutes);

const webhookRoutes = require('./routes/webhook');
app.use('/api/webhook', webhookRoutes.router);

// 前端網頁路由配置
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/apply', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'forms', 'apply.html'));
});

app.get('/users', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'users.html'));
});

app.get('/bind', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'bind.html'));
});

// 系統管理功能：清除測試表單資料 (系統正式上線前應予以移除)
app.get('/api/reset-data', async (req, res) => {
    try {
        // 暫停外鍵檢查以順利清空關聯資料表
        await db.query('SET FOREIGN_KEY_CHECKS = 0');
        
        // 清空表單與紀錄，並將流水號歸零
        await db.query('TRUNCATE TABLE approval_logs');
        await db.query('TRUNCATE TABLE applications');
        
        // 恢復外鍵檢查機制
        await db.query('SET FOREIGN_KEY_CHECKS = 1');
        
        res.send('<h2>系統資料重置完成</h2><p>所有測試表單與簽核紀錄已刪除，新單號將自 #1 重新計算。</p><a href="/dashboard">返回系統大廳</a>');
    } catch (error) {
        console.error('系統資料重置失敗:', error);
        res.status(500).send('重置作業異常，請聯絡系統管理員或檢查環境變數設定。');
    }
});

// API: 執行 LINE 帳號綁定
app.post('/api/bind-line', async (req, res) => {
    const { email, password, lineId } = req.body;
    try {
        // 驗證員工帳號密碼
        const [users] = await db.query('SELECT id, name FROM users WHERE email = ? AND password_hash = ?', [email, password]);
        if (users.length > 0) {
            // 更新 LINE ID 紀錄
            await db.query('UPDATE users SET line_user_id = ? WHERE id = ?', [lineId, users[0].id]);

            const { sendLineMessage } = require('./routes/webhook');
            await sendLineMessage(lineId, `綁定作業完成。歡迎登入系統，${users[0].name}。`);

            res.json({ success: true });
        } else {
            res.json({ success: false, message: '登入信箱或密碼驗證錯誤' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '系統連線異常，請稍後再試' });
    }
});

// API: 系統登入驗證
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '請輸入完整的帳號與密碼資訊' });
    }

    try {
        const [users] = await db.query(
            'SELECT id, name, email, role FROM users WHERE email = ? AND password_hash = ?',
            [email, password]
        );

        if (users.length > 0) {
            res.json({ success: true, user: users[0], redirect: '/dashboard' });
        } else {
            res.status(401).json({ success: false, message: '帳號或密碼錯誤，請重新確認' });
        }
    } catch (error) {
        console.error('資料庫查詢異常:', error);
        res.status(500).json({ success: false, message: '伺服器內部連線錯誤，請確認資料庫運行狀態' });
    }
});

// 啟動伺服器並監聽指定連接埠
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(` 企業行政簽核系統啟動成功`);
    console.log(` 服務運行於 Port: ${PORT}`);
    console.log(` 系統首頁: http://localhost:${PORT}`);
    console.log(`===========================================`);
});