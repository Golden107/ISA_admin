require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db'); // 💡 引入資料庫連線
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- API 路由掛載 ---
const formRoutes = require('./routes/forms');
app.use('/api/forms', formRoutes);

const userRoutes = require('./routes/users');
app.use('/api/users', userRoutes);

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

// 💡 真實資料庫版登入 API
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '請完整輸入帳號與密碼' });
    }

    try {
        // 依照你 users.js 的欄位命名 (password_hash) 進行查詢
        const [users] = await db.query(
            'SELECT id, name, email, role FROM users WHERE email = ? AND password_hash = ?',
            [email, password]
        );

        if (users.length > 0) {
            // 登入成功：取出該名使用者的資料並回傳
            const userData = users[0];
            res.json({ success: true, user: userData, redirect: '/dashboard' });
        } else {
            // 登入失敗：資料庫找不到相符的帳密
            res.status(401).json({ success: false, message: '帳號或密碼錯誤，請重新輸入' });
        }
    } catch (error) {
        console.error('資料庫查詢發生錯誤:', error);
        res.status(500).json({ success: false, message: '伺服器內部錯誤，請聯絡系統管理員' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(` 補教行政系統已啟動！(真實資料庫版)`);
    console.log(` 請在瀏覽器輸入首頁網址: http://localhost:${PORT}`);
    console.log(`===========================================`);
});