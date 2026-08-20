/**
 * 015 — soft delete de mensalidade.
 *
 * A tela de Mensalidades ganhou "Apagar", que é diferente de "Cancelar":
 * cancelar mantém o registro no CRM com status `cancelled` e continua
 * aparecendo no filtro de canceladas; apagar tira a mensalidade da
 * circulação — ela some de todas as listas, contadores e buscas.
 *
 * Por que soft delete e não DELETE de verdade:
 *
 *  1. É o padrão que `crm_cards` e `crm_contacts` já usam neste banco, e um
 *     terceiro comportamento para a mesma palavra confundiria quem lê.
 *  2. A linha carrega `stripe_subscription_id`, `stripe_customer_id` e
 *     `last_invoice_id`. Apagar de vez deixaria uma assinatura viva no
 *     gateway sem nada no CRM apontando para ela — e a conciliação de quem
 *     pagou o quê perderia a referência.
 *  3. `crm_dunning_log` referencia a assinatura pelo id; sem a linha, o
 *     histórico de cobrança vira registro órfão.
 *
 * Apagar no CRM não toca no gateway. Quem quiser encerrar a cobrança de
 * verdade usa "Cancelar", que é a ação com esse significado.
 *
 * Idempotente: confere a coluna antes de criar, porque ALTER TABLE ... ADD
 * COLUMN não aceita IF NOT EXISTS no SQLite.
 */
import type { Database } from 'better-sqlite3';

export const version = 15;
export const description = 'soft delete de mensalidade (crm_subscriptions.deleted_at)';

export function up(db: Database): void {
  // A tabela pode não existir: num banco legado o migrator marca a v1 como
  // aplicada sem rodar o `up()` dela, e o schema base é criado depois, por
  // outro caminho. Sem esta guarda, o ALTER estoura com "no such table" e
  // derruba a cadeia inteira de migrations. Quando a tabela nascer, já virá
  // com a coluna — o schema base a inclui.
  const existe = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='crm_subscriptions'"
  ).get();
  if (!existe) return;

  const colunas = db.prepare('PRAGMA table_info(crm_subscriptions)').all() as Array<{ name: string }>;
  if (!colunas.some((c) => c.name === 'deleted_at')) {
    db.exec('ALTER TABLE crm_subscriptions ADD COLUMN deleted_at INTEGER');
  }
  // As listagens filtram por tenant + status e agora também por deleted_at;
  // o índice parcial mantém o caminho quente sem carregar as apagadas.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_vivas
      ON crm_subscriptions(tenant_id, status, next_charge_at)
      WHERE deleted_at IS NULL;
  `);
}

export function down(db: Database): void {
  // SQLite antigo não remove coluna; deixar a coluna é inofensivo, e o índice
  // some para não segurar o plano de consulta.
  db.exec('DROP INDEX IF EXISTS idx_subscriptions_vivas');
}
