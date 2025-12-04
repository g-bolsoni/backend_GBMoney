const jwt = require("jsonwebtoken");

const billsController = require("./controllers/billsController");
const filterController = require("./controllers/filterController");
const authController = require("./controllers/authController");
const userController = require("./controllers/userController");
const categoryControler = require("./controllers/categoriesController");
const importController = require("./controllers/importController");

async function routes(fastify, options) {
  // Middleware para autenticação
  fastify.decorate("verifyToken", async (request, reply) => {
    const token = request.headers["authorization"];

    if (!token) {
      return reply.status(401).send({ message: "No token provided" });
    }

    try {
      const cleanToken = token.replace('Bearer ', '');
      const decoded = jwt.verify(cleanToken, process.env.SECRET);
      request.user_id = decoded.id;
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ message: "Invalid token" });
    }
  });

  // Bills
  fastify.get(
    "/bills",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Bills"],
        querystring: {
          type: "object",
          properties: {
            page: { type: "number" },
            limit: { type: "number" },
            sortBy: { type: "string" },
            orderBy: { type: "string" },
          },
          required: ["page", "limit", "sortBy", "orderBy"],
        },
      },
    },
    billsController.index
  );
  fastify.get(
    "/bills/:id",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Bills"],
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      },
    },
    billsController.findOne
  );
  fastify.post(
    "/bills",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Bills"],
        body: {
          type: "object",
          required: ["bill_name", "bill_value", "bill_category", "bill_type", "buy_date"],
          properties: {
            bill_name: { type: "string" },
            bill_value: { type: "number" },
            bill_category: { type: "string" },
            bill_type: { type: "string" },
            buy_date: { type: "string" },
            payment_type: { type: "string" },
            repeat: { type: "boolean" },
            installments: { type: "string" },
            fixed: { type: "boolean" },
          },
        },
      },
    },
    billsController.createBills
  );
  fastify.put(
    "/bills/:id",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Bills"],
        body: {
          type: "object",
          required: ["bill_name", "bill_value", "bill_category", "bill_type", "buy_date"],
          properties: {
            bill_name: { type: "string" },
            bill_value: { type: "number" },
            bill_category: { type: "string" },
            bill_type: { type: "string" },
            buy_date: { type: "string" },
            payment_type: { type: "string" },
            repeat: { type: "boolean" },
            installments: { type: "string" },
            fixed: { type: "boolean" },
          },
        },
      },
    },
    billsController.updateBills
  );
  fastify.delete(
    "/bills/:id",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Bills"],
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      },
    },
    billsController.deleteBills
  );
  fastify.delete(
    "/bills",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Bills"],
        querystring: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" } },
          },
          required: ["ids"],
        },
      },
    },
    billsController.deleteAllBills
  );
  fastify.post(
    "/updateMonthlyBills",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Bills"],
        body: {
          type: "object",
          required: ["month", "year"],
          properties: {
            month: { type: "number" },
            year: { type: "number" },
          },
        },
      },
    },
    billsController.createMonthlyBills
  );

  // Bills filters
  fastify.post(
    "/filter",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Filters"],
        body: {
          type: "object",
          required: ["startDate", "endDate", "category_id", "bill_type"],
          properties: {
            startDate: { type: "string", format: "date" },
            endDate: { type: "string", format: "date" },
            category_id: { type: "string" },
            bill_type: { type: "string" },
          },
        },
      },
    },
    billsController.filterBills
  );
  fastify.get(
    "/filter",
    {
      schema: {
        tags: ["Filters"],
        querystring: {
          type: "object",
          properties: {
            startDate: { type: "string", format: "date" },
            endDate: { type: "string", format: "date" },
            category_id: { type: "string" },
            bill_type: { type: "string" },
          },
        },
      },
    },
    filterController.getData
  );

  // Auth
  fastify.post(
    "/auth/register",
    {
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            name: { type: "string" },
            email: { type: "string", format: "email" },
            password: { type: "string" },
            confirmPassword: { type: "string" },
          },
        },
        response: {
          442: {
            type: "object",
            properties: {
              field: { type: "string" },
              message: { type: "string" },
            },
          },
          201: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
          500: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    authController.registerUser
  );
  fastify.post(
    "/auth/login",
    {
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
          },
        },
        response: {
          422: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              field: { type: "string" },
              message: { type: "string" },
            },
          },
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
              Token: { type: "string" },
            },
          },
          500: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    authController.loginUser
  );
  fastify.post(
    "/resetPassword",
    {
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
          },
        },
        response: {
          422: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
          400: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    authController.resetPassword.bind(authController)
  );
  fastify.post(
    "/resetPasswordConfirm",
    {
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["email", "code", "password"],
          properties: {
            token: { type: "string" },
            password: { type: "string" },
            confirmPassword: { type: "string" },
          },
        },
        response: {
          422: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              field: { type: "string" },
              message: { type: "string" },
            },
          },
          400: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              field: { type: "string" },
              message: { type: "string" },
            },
          },
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    authController.resetPasswordConfirm
  );

  // User
  fastify.get(
    "/user",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["User"],
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              email: { type: "string", format: "email" },
            },
          },
          422: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    userController.getUser
  );
  fastify.put(
    "/user",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["User"],
        body: {
          type: "object",
          required: ["name", "email"],
          properties: {
            name: { type: "string" },
            email: { type: "string", format: "email" },
          },
        },
      },
    },
    userController.updateUserInfo
  );
  fastify.delete(
    "/user",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["User"],
        response: {
          200: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
          401: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
          500: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    userController.deleteUser
  );

  // Categories
  fastify.get(
    "/category",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Categories"],
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                user_id: { type: "string" },
              },
            },
          },
          401: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
          500: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
          422: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    categoryControler.getCategories
  );
  fastify.post(
    "/category",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Categories"],
        body: {
          type: "object",
          required: ["name", "description", "color", "icon", "category_type", "isActive", "budget"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            color: { type: "string" },
            icon: { type: "string" },
            category_type: { type: "string" },
            isActive: { type: "boolean" },
            budget: { type: "string" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              color: { type: "string" },
              icon: { type: "string" },
              category_type: { type: "string" },
              isActive: { type: "boolean" },
              budget: { type: "number" },
            },
          },
          500: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    categoryControler.createCategory
  );
  fastify.delete(
    "/category/:id",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Categories"],
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
          401: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
          500: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    categoryControler.deleteCategory
  );

  // Import routes
  fastify.post(
    "/import/upload",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Import"],
        consumes: ["multipart/form-data"],
        response: {
          200: {
            type: "object",
            properties: {
              uploadId: { type: "string" },
              preview: { type: "object" },
              message: { type: "string" }
            }
          },
          400: {
            type: "object",
            properties: {
              error: { type: "string" }
            }
          }
        }
      }
    },
    importController.uploadFile
  );

  fastify.get(
    "/import/preview/:uploadId",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Import"],
        params: {
          type: "object",
          properties: {
            uploadId: { type: "string" }
          },
          required: ["uploadId"]
        },
        response: {
          200: {
            type: "object",
            properties: {
              uploadId: { type: "string" },
              preview: { type: "object" },
              filename: { type: "string" }
            }
          },
          404: {
            type: "object",
            properties: {
              error: { type: "string" }
            }
          }
        }
      }
    },
    importController.getPreview
  );

  fastify.post(
    "/import/confirm/:uploadId",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Import"],
        params: {
          type: "object",
          properties: {
            uploadId: { type: "string" }
          },
          required: ["uploadId"]
        },
        body: {
          type: "object",
          properties: {
            mapping: { type: "object" },
            categoryMapping: { type: "object" }
          },
          additionalProperties: true
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
              uploadId: { type: "string" },
              sessionId: { type: "string" }
            }
          }
        }
      }
    },
    importController.confirmImport
  );

  // Streaming progress routes
  fastify.get(
    "/import/progress/:uploadId/stream",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Import", "Streaming"],
        params: {
          type: "object",
          properties: {
            uploadId: { type: "string" }
          },
          required: ["uploadId"]
        },
        produces: ["text/event-stream"]
      }
    },
    async (request, reply) => {
      const streamingService = require('./services/streamingService');
      return streamingService.createSSEEndpoint(request, reply);
    }
  );

  fastify.get(
    "/import/status/:uploadId",
    {
      preHandler: fastify.verifyToken,
      schema: {
        tags: ["Import", "Streaming"],
        params: {
          type: "object",
          properties: {
            uploadId: { type: "string" }
          },
          required: ["uploadId"]
        },
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              progress: { type: "number" },
              processedRows: { type: "number" },
              totalRows: { type: "number" },
              successfulRows: { type: "number" },
              errorRows: { type: "number" },
              estimatedTimeRemaining: { type: "number" },
              processingSpeed: { type: "number" }
            }
          },
          404: {
            type: "object",
            properties: {
              error: { type: "string" }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const streamingService = require('./services/streamingService');
      const { uploadId } = request.params;

      const session = streamingService.getSessionStatus(uploadId);

      if (!session) {
        return reply.status(404).send({
          error: 'Sessão de importação não encontrada'
        });
      }

      if (session.userId !== request.user_id) {
        return reply.status(403).send({
          error: 'Não autorizado'
        });
      }

      return reply.send({
        status: session.status,
        progress: session.progress,
        processedRows: session.processedRows,
        totalRows: session.totalRows,
        successfulRows: session.successfulRows,
        errorRows: session.errorRows,
        estimatedTimeRemaining: session.estimatedTimeRemaining,
        processingSpeed: session.processingSpeed,
        errors: session.errors?.slice(-10) || [] // Últimos 10 erros
      });
    }
  );
}

module.exports = routes;
