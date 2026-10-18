# Finding the table and column mapping in code

Search the code root for the table name first (`orders`, `"orders"`,
`example.orders`), then follow what you find. The mapping is certain only
when the code names the table and column explicitly, or the mapping layer
applies a documented naming convention. Examples use the alias set
(`example.orders`, `order_id`, `customer_id`, `status_code`, `amount`;
code root `example_app`).

| Stack | Where the mapping lives | What to look for |
|---|---|---|
| .NET EF Core / EF6 | entity classes, `DbContext.OnModelCreating`, `IEntityTypeConfiguration<T>` | `[Table("orders", Schema = "example")]`, `[Column("status_code")]`, `ToTable("orders", "example")`, `Property(x => x.StatusCode).HasColumnName("status_code")`, `UseSnakeCaseNamingConvention()` |
| Java JPA / Hibernate | entity classes, `orm.xml` | `@Table(name = "orders", schema = "example")`, `@Column(name = "amount")`, a configured `PhysicalNamingStrategy` |
| Python SQLAlchemy / Django | models | `__tablename__ = "orders"`, `Column("customer_id", ...)`, `db_table = "orders"`, `db_column="status_code"` |
| Node (TypeORM, Sequelize, Prisma, Knex) | entities, model definitions, `schema.prisma`, query builders | `@Entity({ name: "orders", schema: "example" })`, `@Column({ name: "amount" })`, `tableName: "orders"`, `@@map("orders")`, `@map("order_id")` |
| Dapper, ADO.NET, JDBC, raw SQL | repositories, SQL files, string constants | `SELECT ... FROM example.orders`, column aliases mapped onto properties |
| Rails ActiveRecord | models, `db/schema.rb` | `self.table_name = "orders"`, attribute names equal to column names |

Then follow the mapped property, not the column name, through the code:

- **Computation:** `order.Amount = net + tax + shipping;` -> "appears to be
  the total of net, tax and shipping". Reference: `src/Orders/OrderService.cs`,
  line, symbol `OrderService.CalculateTotal`.
- **UI label:** a grid header or form label bound to the property, or a
  resource string used for it. Reference the template or resource file.
- **Permission or visibility:** a flag that hides or locks the field for
  some users. Say what the flag gates, not who the users are.
- **Validation:** required, range or format rules and their messages.
- **Enum or constant:** `if (order.StatusCode == OrderStatus.Delivered)` ->
  the column holds `OrderStatus` values; name the enum, do not list
  business meanings the code does not state.

Skip a column when:

- two tables or two properties could map to it and the code does not say
  which;
- the only evidence is the column name itself;
- the property is mapped but never read, written or shown (say "mapped, no
  use found").
