# Stock postgres:16 plus only what the pgTAP harness needs: the pgtap extension and
# pg_prove (libtap-parser-sourcehandler-pgtap-perl). Deliberately NOT the supabase image.
FROM postgres:16

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-16-pgtap \
        libtap-parser-sourcehandler-pgtap-perl \
    && rm -rf /var/lib/apt/lists/*
