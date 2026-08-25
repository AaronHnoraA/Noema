package api

import (
	"net/http"

	"github.com/88250/gulu"
	noemaagenda "github.com/aaronhe/noema/kernel/noema/agenda"
	"github.com/gin-gonic/gin"
)

func evaluateNoemaAgenda(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	var request noemaagenda.EvaluateRequest
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if nil == request.Todos {
		ret.Code = -1
		ret.Msg = "todos are required"
		return
	}
	ret.Data = noemaagenda.Evaluate(request)
}
