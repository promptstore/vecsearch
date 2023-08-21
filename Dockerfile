FROM node:14

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install
# If you are building your code for production
# RUN npm ci --only=production

# Bundle app source
COPY ./server.js .
COPY ./logger.js .

EXPOSE 6010

CMD [ "node", "server.js", "--unhandled-rejections=strict", "--trace-warnings" ]