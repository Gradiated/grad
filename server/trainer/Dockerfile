# syntax=docker/dockerfile:1.7

FROM python:3.13-slim AS base
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN useradd --create-home --uid 10001 grad

COPY pyproject.toml README.md ./
COPY grad_trainer ./grad_trainer
RUN pip install --no-cache-dir --no-deps .

FROM base AS cpu
USER grad
CMD ["grad-trainer"]

FROM base AS gpu
RUN pip install --no-cache-dir ".[gpu]"
USER grad
CMD ["grad-trainer"]
