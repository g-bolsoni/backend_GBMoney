const moment = require("moment");

const billsModel = require("../models/billsModel");
const jwt = require("jsonwebtoken");
const User = require("../models/usersModel");

class productController {
  async index(request, reply) {
    //Listar todas contas
    try {
      console.log('📋 billsController.index: Buscando bills para user_id:', request.user_id);

      const bills = await billsModel.find({ user_id: request.user_id });

      console.log('📊 billsController.index: Encontradas', bills.length, 'bills');
      console.log('📅 billsController.index: Sample bills:', bills.slice(0, 2).map(b => ({
        id: b._id,
        description: b.description,
        value: b.value,
        buy_date: b.buy_date
      })));

      return reply.status(200).send(bills);
    } catch (error) {
      console.error('❌ billsController.index: Erro ao buscar bills:', error);
      return reply.status(500).send({ message: "Erro interno do servidor" });
    }
  }

  async findOne(request, reply) {
    //Listar uma conta

    try {
      const { id } = request.params;

      const bill = await billsModel.findById({ _id: id, user_id: request.user_id });

      if (!bill) {
        return reply.status(404).send({ message: "Not Found" });
      }

      return reply.status(200).send(bill);
    } catch (error) {
      return reply.status(404).send({ message: "Bill not found" });
    }
  }

  async createBills(request, reply) {
    //Criar conta
    try {
      const billData = request.body;
      billData.user_id = request.user_id;

      console.log('➕ Criando bill com dados:', billData);
      const savedBill = await billsModel.create(billData);
      console.log('➕ savedBill criada:', savedBill);

      return reply.status(200).send({ message: "Bill has been created!" });
    } catch (error) {
      console.log('Erro ao criar bill:', error);
      reply.status(404).send({ message: error });
    }
  }

  // Função auxiliar para criar uma bill com dados diretos (sem request/reply)
  async createBillData(billData) {
    console.log('➕ createBillData: Criando bill com dados:', billData);
    try {
      const savedBill = await billsModel.create(billData);
      console.log('➕ createBillData: savedBill criada:', savedBill._id);
      return savedBill;
    } catch (error) {
      console.error('❌ createBillData: Erro ao salvar:', error);
      throw new Error(`Erro ao salvar transação: ${error.message}`);
    }
  }

  async updateBills(request, reply) {
    //Atualizar conta
    const { id } = request.params;
    try {
      const bill = await billsModel.findOneAndUpdate({ _id: id, user_id: request.user_id }, request.body, { new: true });

      if (!bill) {
        return reply.status(404).send({ message: "This id not exists" });
      }

      return reply.status(200).send({ message: "Item updated successfully" });
    } catch (error) {
      return reply.status(404).send({ message: "This id not exists" });
    }
  }

  async deleteBills(request, reply) {
    //Deletar conta
    const { id } = request.params;

    try {
      const bill = await billsModel.findOneAndDelete({
        _id: id,
        user_id: request.user_id,
      });

      if (!bill) {
        return reply.status(404).send({ message: "Bills not found" });
      }
      return reply.status(200).send({ message: "Bills successfully deleted" });
    } catch (error) {
      return reply.status(404).send({ message: "Bills not found" });
    }
  }

  async deleteAllBills(request, reply) {
    //Deletar conta
    try {
      billsModel.deleteMany({ user_id: request.user_id });
      return reply.status(200).send({ message: "Bills successfully deleted" });
    } catch (error) {
      return reply.status(404).send({ message: "Bills not found" });
    }
  }

  async filterBills(request, reply) {
    //Filtrar resultados

    if (!request.body) {
      return reply.status(404).send({ message: "Not found" });
    }

    try {
      const filter = await billsModel.find({
        ...request.body,
        user_id: request.user_id,
      }); // Garantir que a consulta inclua user_id
      return reply.status(200).send(filter);
    } catch (error) {
      return reply.status(404).send({ message: "Fileter failed" });
    }
  }

  async createMonthlyBills(request, reply) {
    const { user_id } = request;

    const startOfLastMonth = moment().subtract(1, "month").startOf("month").toDate();
    const endOfLastMonth = moment().subtract(1, "month").endOf("month").toDate();

    try {
      const billsUpdate = [];

      // get all bills are fixed or be repeated for this month
      const getAllBillsForLastMonth = await billsModel.find({
        user_id: user_id,
        buy_date: {
          $gte: startOfLastMonth,
          $lte: endOfLastMonth,
        },
        $or: [{ fixed: true }, { repeat: true }],
      });

      if (getAllBillsForLastMonth.length === 0) {
        console.error("Nenhuma conta fixa encontrada para o mês passado.");
      }

      // for each bill, create a new bill for this month
      let parcel = 0;
      let totalParcel = 0;

      for (const bill of getAllBillsForLastMonth) {
        if (bill.repeat) {
          parcel = parseInt(bill.installments.split("/")[0]);
          totalParcel = parseInt(bill.installments.split("/")[1]);
          if (parcel == totalParcel) continue;
        }

        const data = {
          user_id: user_id,
          bill_name: bill.bill_name,
          bill_category: bill.bill_category,
          bill_type: bill.bill_type,
          bill_value: bill.bill_value,
          buy_date: endOfLastMonth,
          fixed: bill.fixed,
          repeat: bill.repeat,
          installments: bill.repeat ? `${parcel + 1}/${totalParcel}` : bill.installments,
          payment_type: bill.payment_type,
        };

        const billCreated = await billsModel.create(data);
        billsUpdate.push(billCreated);
      }

      return reply.status(200).send({
        message: "Monthly bills created successfullyy!",
        data: billsUpdate,
      });
    } catch (error) {
      reply.status(404).send({ message: error });
    }
  }
}

module.exports = new productController();
