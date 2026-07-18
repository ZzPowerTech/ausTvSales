CREATE UNIQUE INDEX "categories_name_lower_unique" ON "categories" USING btree (lower("name"));
