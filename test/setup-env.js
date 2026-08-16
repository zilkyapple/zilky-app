// Los tests corren contra una base Postgres real (no en memoria), para que las queries
// se validen tal cual corren en producción. Por defecto usa una base local de prueba;
// se puede apuntar a otra con TEST_DATABASE_URL.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/zilky_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-solo-para-tests';
