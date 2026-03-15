const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'RepoLens Bot is running' });
});

app.listen(PORT, () => {
  console.log(`Bot server running on port ${PORT}`);
});