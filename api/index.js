// Import required modules
const express = require("express"); // Express.js framework for creating web applications
const mongoose = require("mongoose"); // Mongoose library for MongoDB object modeling
const dotenv = require("dotenv"); // dotenv for managing environment variables
const jwt = require("jsonwebtoken"); // jsonwebtoken for creating and verifying JWT tokens
const cors = require("cors"); // CORS middleware for handling Cross-Origin Resource Sharing
const User = require("./models/User"); // Import the User model from a local file
const Message = require("./models/Message");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const ws = require("ws");
const fs = require("fs");

// Load environment variables from .env file
dotenv.config();

// Connect to MongoDB using the provided connection string
mongoose
  .connect(process.env.MONGO_URL)
  .then(() => {
    console.log("Server is running on port: 4000!"); // Log success message if connection is successful
  })
  .catch((err) => {
    console.error("Error connecting to MongoDB:", err); // Log error if connection fails
  });

// Retrieve JWT secret from environment variables
const jwtSecret = process.env.JWT_SECRET;
const bcryptSalt = bcrypt.genSaltSync(10);

// Create an Express application
const app = express();

app.use("/uploads", express.static(__dirname + "/uploads"));

// Middleware to parse JSON bodies of incoming requests
app.use(express.json());

app.use(cookieParser());

// CORS middleware to handle Cross-Origin Resource Sharing
app.use(
  cors({
    credentials: true,
    origin: process.env.CLIENT_URL, // Allow requests from the specified origin (client URL)
  })
);

async function getUserDataFromRequest(req) {
  return new Promise((resolve, reject) => {
    const token = req.cookies?.token;
    if (token) {
      jwt.verify(token, jwtSecret, {}, (err, userData) => {
        if (err) throw err;
        resolve(userData);
      });
    } else {
      reject("no token");
    }
  });
}

// Define a test endpoint
app.get("/test", (req, res) => {
  res.json("test ok");
});

app.get("/messages/:userId", async (req, res) => {
  const { userId } = req.params;
  const userData = await getUserDataFromRequest(req);
  const ourUserId = userData.userId;
  // console.log({ userId, ourUserId });
  const messages = await Message.find({
    sender: { $in: [userId, ourUserId] },
    recipient: { $in: [userId, ourUserId] },
  }).sort({ createdAt: 1 });
  res.json(messages);
});

app.get("/people", async (req, res) => {
  const users = await User.find({}, { _id: 1, username: 1 });
  res.json(users);
});

app.get("/profile", (req, res) => {
  const token = req.cookies?.token;
  if (token) {
    jwt.verify(token, jwtSecret, {}, (err, userData) => {
      if (err) throw err;
      const { id, username } = userData;
      res.json(userData);
    });
  } else {
    res.status(401).json("Token does not exists!");
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const foundUser = await User.findOne({ username });
  if (foundUser) {
    const passOk = bcrypt.compareSync(password, foundUser.password);
    if (passOk) {
      jwt.sign(
        { userId: foundUser._id, username },
        jwtSecret,
        {},
        (err, token) => {
          res.cookie("token", token, { sameSite: "none", secure: true }).json({
            id: foundUser._id,
          });
        }
      );
    }
  }
});

app.post("/logout", (req, res) => {
  res.cookie("token", "", { sameSite: "none", secure: true }).json("ok");
});

// Define a POST endpoint for user registration
app.post("/register", async (req, res) => {
  const { username, password } = req.body; // Extract username and password from request body
  try {
    const hashedPassword = bcrypt.hashSync(password, bcryptSalt);
    // Create a new user document using the User model and provided username/password
    const createdUser = await User.create({
      username: username,
      password: hashedPassword,
    });

    jwt.sign(
      { userId: createdUser._id, username },
      jwtSecret,
      {},
      (err, token) => {
        if (err) throw err; // Throw error if JWT token generation fails
        // Set the JWT token as a cookie and respond with the user's ID
        res
          .cookie("token", token, { sameSite: "none", secure: true })
          .status(201)
          .json({
            _id: createdUser._id,
          });
      }
    );
  } catch (err) {
    if (err) throw err; // Throw error if user creation fails
    res.status(500).json("error");
  }
});

// Start the Express server and listen on port 4000
const server = app.listen(4000);

const wss = new ws.WebSocketServer({ server });
wss.on("connection", (connection, req) => {
  function notifyAboutOnlinePeople() {
    [...wss.clients].forEach((client) => {
      client.send(
        JSON.stringify({
          online: [...wss.clients].map((c) => ({
            userId: c.userId,
            username: c.username,
          })),
        })
      );
    });
  }

  connection.isAlive = true;
  connection.timer = setInterval(() => {
    connection.ping();
    connection.deathTimer = setTimeout(() => {
      connection.isAlive = false;
      clearInterval(connection.timer);
      connection.terminate();
      notifyAboutOnlinePeople();
      // console.log('dead');
    }, 1000);
  }, 5000);

  connection.on(
    "pong",
    () => {
      clearTimeout(connection.deathTimer);
    },
    5000
  );
  // console.log('Connected!');
  // connection.send('Hello!');
  // console.log(req.headers); ...This header contaon cookie which has token

  // raed username & id from cookie for connection
  const cookies = req.headers.cookie;
  if (cookies) {
    const tokenCookieString = cookies
      .split(";")
      .find((str) => str.startsWith("token="));
    // console.log(tokenCookieString);

    if (tokenCookieString) {
      const token = tokenCookieString.split("=")[1];
      if (token) {
        // console.log(token);
        jwt.verify(token, jwtSecret, {}, (err, userData) => {
          if (err) throw err;
          // console.log(userData);  //for eg. userData = { userId: '65df3ff53ff54230bab4dc2f', username: 'test1', iat: 1709129717 }
          const { userId, username } = userData;
          // saving userId, username to connection
          connection.userId = userId;
          connection.username = username;
          // console.log(connection);
        });
      }
    }
  }

  connection.on("message", async (message) => {
    // console.log(typeof message);...Object
    const messageData = JSON.parse(message.toString());
    // console.log(messageData);

    const { recipient, text, file } = messageData;
    let fileName = null;
    if (file) {
      // console.log({file});
      // console.log('size', file.data.length);

      const parts = file.name.split(".");
      const ext = parts[parts.length - 1];
      fileName = Date.now() + "." + ext;
      const path = __dirname + "/uploads/" + fileName;
      const bufferData = new Buffer(file.data.split(",")[1], "base64");
      fs.writeFile(path, bufferData, () => {
        console.log("file saved: " + path);
      });
    }
    if (recipient && (text || file)) {
      const messageDoc = await Message.create({
        sender: connection.userId,
        recipient,
        text,
        file: file ? fileName : null,
      });
      console.log("Created message with attached file!");
      [...wss.clients]
        .filter((c) => c.userId === recipient)
        .forEach((c) =>
          c.send(
            JSON.stringify({
              text,
              sender: connection.userId,
              recipient,
              file: file ? fileName : null,
              _id: messageDoc._id,
            })
          )
        );
    }
  });

  // notify everyone about online people (when someone connects)
  // console.log([...wss.clients].length);
  // console.log([...wss.clients].map((c) => c.username));

  notifyAboutOnlinePeople();
});
