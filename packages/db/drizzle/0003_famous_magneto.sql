CREATE TABLE "tm_api_calls" (
	"day" date NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"status_class" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "tm_api_calls_day_method_route_status_class_pk" PRIMARY KEY("day","method","route","status_class")
);
