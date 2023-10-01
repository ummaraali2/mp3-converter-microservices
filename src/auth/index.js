const jwt = require('jsonwebtoken');
const express = require('express');
const mysql = require('mysql');
const app = express();

const connection = mysql.createConnection({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DB,
  port: process.env.MYSQL_PORT
});

app.use(express.json());

app.post('/login', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).send('missing credentials');
  }

  connection.query(
    'SELECT email, password FROM user WHERE email = ?',
    [auth.username],
    (error, results) => {
      if (error) {
        return res.status(500).send('internal server error');
      }

      if (results.length > 0) {
        const user = results[0];
        const email = user.email;
        const password = user.password;

        if (auth.username !== email || auth.password !== password) {
          return res.status(401).send('invalid credentials');
        } else {
          const token = createJWT(auth.username, process.env.JWT_SECRET, true);
          return res.status(200).json({ token });
        }
      } else {
        return res.status(401).send('invalid credentials');
      }
    }
  );
});

app.post('/validate', (req, res) => {
  const encodedJwt = req.headers.authorization;
  if (!encodedJwt) {
    return res.status(401).send('missing credentials');
  }

  const token = encodedJwt.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // continue with validation logic
  } catch (error) {
    return res.status(401).send('invalid token');
  }
});

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});