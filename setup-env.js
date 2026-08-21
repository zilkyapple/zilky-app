process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/zilky_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-solo-para-tests';
