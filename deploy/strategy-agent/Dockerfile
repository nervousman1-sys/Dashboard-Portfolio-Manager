FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY strategy-agent.js ./
# 24/7 automated-strategy evaluator + paper executor (Finextium)
CMD ["node", "strategy-agent.js"]
