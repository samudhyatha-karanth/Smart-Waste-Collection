import { Router, type IRouter } from "express";
import healthRouter from "./health";
import smartWasteRouter from "./smart-waste";

const router: IRouter = Router();

router.use(healthRouter);
router.use(smartWasteRouter);

export default router;
