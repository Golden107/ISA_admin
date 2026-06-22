const mysql = require('mysql2');
require('dotenv').config(); // 載入 .env 檔案中的環境變數

// 建立資料庫連線池 (Connection Pool)
// 使用 Pool 可以讓系統自動管理多個連線，提升效能與穩定性
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 將連線池轉換為支援 Promise 的版本，這樣我們就能使用 async/await
module.exports = pool.promise();