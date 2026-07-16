import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { createAuthenticatedApp } from './e2e-utils';

describe('Categories (e2e)', () => {
  let app: INestApplication<App>;
  let authCookie: string;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE sales, items, players, categories RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('requires authentication to create a category (401)', () => {
    return http().post('/categories').send({ name: 'Caixas' }).expect(401);
  });

  it('creates and lists a category', async () => {
    const created = await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'Caixas', display_order: 1 })
      .expect(201);

    expect(created.body).toMatchObject({ name: 'Caixas', displayOrder: 1 });

    const list = await http()
      .get('/categories')
      .set('Cookie', authCookie)
      .expect(200);
    const categories = list.body as Array<{ name: string }>;
    expect(categories).toHaveLength(1);
    expect(categories[0].name).toBe('Caixas');
  });

  it('rejects a duplicate name case-insensitively (409)', async () => {
    await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'Caixas' })
      .expect(201);

    await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'caixas' })
      .expect(409);
  });

  it('rejects an empty name (400)', () => {
    return http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: '   ' })
      .expect(400);
  });

  it('updates a category name and order', async () => {
    const created = await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'Caixas' })
      .expect(201);

    const updated = await http()
      .patch(`/categories/${(created.body as { id: number }).id}`)
      .set('Cookie', authCookie)
      .send({ name: 'Caixas de Natal', display_order: 5 })
      .expect(200);

    expect(updated.body).toMatchObject({
      name: 'Caixas de Natal',
      displayOrder: 5,
    });
  });

  it('rejects a PATCH with no updatable fields (400)', async () => {
    const created = await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'Caixas' })
      .expect(201);

    await http()
      .patch(`/categories/${(created.body as { id: number }).id}`)
      .set('Cookie', authCookie)
      .send({})
      .expect(400);
  });

  it('returns 404 when updating a missing category', () => {
    return http()
      .patch('/categories/999')
      .set('Cookie', authCookie)
      .send({ name: 'Ghost' })
      .expect(404);
  });
});
