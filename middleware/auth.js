import jwt from 'jsonwebtoken';

// Middleware factory that creates authenticate middleware with dependencies
export const createAuthenticate = (JWT_SECRET, User) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
      }
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.sub);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      req.user = user;
      next();
    } catch (err) {
      res.status(401).json({ error: 'Invalid token' });
    }
  };
};

// WebSocket authentication middleware factory
export const createAuthenticateSocket = (JWT_SECRET, User) => {
  return async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }
      
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.sub);
      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }
      
      socket.userId = user._id.toString();
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Authentication error: Invalid token'));
    }
  };
};

// Helper function to sign JWT tokens
export const createSignToken = (JWT_SECRET) => {
  return (userId) => jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
};

