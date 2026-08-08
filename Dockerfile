FROM python:3.12-slim

WORKDIR /app

COPY server.py /app/server.py
COPY static /app/static

# 配置文件（含 GitHub 令牌）保存在 data/，请用卷挂载持久化
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV HOST=0.0.0.0
ENV PORT=8000
EXPOSE 8000

CMD ["python", "server.py"]
