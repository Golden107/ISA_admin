const express = require('express');
const axios = require('axios');
const router = express.Router();

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_TOKEN || '您在LINE開發者後台取得的Token';

// 共用函數：主動發送 LINE 訊息給特定員工或主管
async function sendLineMessage(lineUserId, textMessage) {
    if (!lineUserId) return;

    try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUserId,
            messages: [
                {
                    type: 'text',
                    text: textMessage
                }
            ]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
            }
        });
        console.log('LINE 通知發送成功');
    } catch (error) {
        console.error('LINE API 發生錯誤', error.response ? error.response.data : error.message);
    }
}

// 匯出模組供表單 API 呼叫
module.exports = {
    sendLineMessage
};