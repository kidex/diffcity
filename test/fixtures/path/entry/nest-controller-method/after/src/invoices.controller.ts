@Controller('invoices')
export class InvoicesController {
  @Get(':id')
  find(id: string) {
    return id.toUpperCase();
  }

  @Post()
  create(body: unknown) {
    return body;
  }
}
