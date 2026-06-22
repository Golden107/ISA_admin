require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db'); // 確保資料庫路徑是 ./db
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- API 路由掛載 ---
const formRoutes = require('./routes/forms');
app.use('/api/forms', formRoutes);

const userRoutes = require('./routes/users');
app.use('/api/users', userRoutes);

// 掛載 LINE Webhook API
const webhookRoutes = require('./routes/webhook');
app.use('/api/webhook', webhookRoutes.router);

// --- 網頁畫面路由設定 ---
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
// 💡 新增：顯示手機版安全綁定網頁
app.get('/bind', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'bind.html'));
});

// 💡 新增：處理安全綁定的專屬 API
app.post('/api/bind-line', async (req, res) => {
    const { email, password, lineId } = req.body;
    try {
        // 去資料庫檢查帳密是否正確
        const [users] = await db.query('SELECT id, name FROM users WHERE email = ? AND password_hash = ?', [email, password]);
        if (users.length > 0) {
            // 寫入 LINE ID
            await db.query('UPDATE users SET line_user_id = ? WHERE id = ?', [lineId, users[0].id]);

            // 呼叫 Webhook 傳送成功推播
            const { sendLineMessage } = require('./routes/webhook');
            await sendLineMessage(lineId, `✅ 綁定成功！歡迎您，${users[0].name}。`);

            res.json({ success: true });
        } else {
            res.json({ success: false, message: '信箱或密碼錯誤' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '系統連線異常' });
    }
});

// 真實資料庫版登入 API
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '請完整輸入帳號與密碼' });
    }

    try {
        const [users] = await db.query(
            'SELECT id, name, email, role FROM users WHERE email = ? AND password_hash = ?',
            [email, password]
        );

        if (users.length > 0) {
            res.json({ success: true, user: users[0], redirect: '/dashboard' });
        } else {
            res.status(401).json({ success: false, message: '帳號或密碼錯誤，請重新輸入' });
        }
    } catch (error) {
        console.error('資料庫查詢發生錯誤:', error);
        res.status(500).json({ success: false, message: '伺服器內部連線錯誤，請確認資料庫是否已啟動' });
    }
});

// 👇 就是這一段！如果漏掉這個，伺服器就會「秒退」
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(` 補教行政系統已啟動！`);
    console.log(` 監聽 Port: ${PORT}`);
    console.log(` 請在瀏覽器輸入首頁網址: http://localhost:${PORT}`);
    console.log(`===========================================`);
});