-- Создать тестовых пользователей напрямую в БД
-- Пароли захешированы bcrypt: admin123 и user123

INSERT INTO users (username, password_hash, full_name, role)
VALUES 
  ('admin', '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.VHu6yQWjCnx8Gy', 'Administrator', 'admin'),
  ('user', '$2a$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Test User', 'user')
ON CONFLICT (username) DO NOTHING;

-- Проверить
SELECT username, full_name, role, created_at FROM users;