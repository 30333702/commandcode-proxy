FROM node:22-alpine
WORKDIR /app

# 代理本体 + 二开模块（pool/admin 为新增，缺一不可）
COPY package.json config.json proxy.mjs pool.mjs admin.mjs ./
# 管理面板前端（admin.mjs 运行时读取 public/admin.html）
COPY public/ ./public/

# 账号池状态目录：账号、虚拟 Key、统计、日志、密码哈希都在这里
RUN mkdir -p /app/data
ENV CCPOOL_DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --spider http://127.0.0.1:3050/health || exit 1
CMD ["node", "proxy.mjs"]
