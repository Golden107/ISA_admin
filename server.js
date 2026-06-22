require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- API 路由掛載 ---
const formRoutes = require('./routes/forms');
app.use('/api/forms', formRoutes);

// 💡 掛載使用者管理 API (對應剛剛建立的 routes/users.js)
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

// 💡 註冊權限管理的網頁路由
app.get('/users', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'users.html'));
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    if (email && password) {
        res.json({ success: true, redirect: '/dashboard' });
    } else {
        res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(` 補教行政系統已啟動！`);
    console.log(` 請在瀏覽器輸入首頁網址: http://localhost:${PORT}`);
    console.log(`===========================================`);
});