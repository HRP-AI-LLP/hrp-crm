/** Work items across all my projects: queries (saved and starters), with each item opening in place. */
import { QueriesView } from '../components/projects/Work';

export function WorkItemsPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Work items</h1>
          <p>Query stories, bugs and tasks across every project you are on — save queries, share them, export to CSV.</p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-body">
          <QueriesView projectId={null} member={false} />
        </div>
      </section>
    </>
  );
}
