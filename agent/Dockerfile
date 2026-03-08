# 使用官方 Python 轻量级镜像
FROM python:3.10-slim

# 设置工作目录
WORKDIR /app

# 复制依赖文件并安装
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制后端所有代码
COPY . .

# 暴露后端运行的端口（假设是 8000）
EXPOSE 8000

# 启动命令 (请根据你的实际框架修改，这里以 FastAPI/Uvicorn 为例)
# 如果是 Flask，可能是 CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:8000", "main:app"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]